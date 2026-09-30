//! Cursor sampling on Linux, through Hyprland's IPC socket.
//!
//! Wayland gives applications no global cursor position, and the X11 hooks
//! the recorder uses on Windows see only XWayland windows. Hyprland answers
//! `cursorpos` on its control socket, so under Hyprland the position is
//! available; elsewhere every snapshot reports why it is not.
//!
//! Same exports and JSON shape as `cursor.rs`. There is no cursor bitmap or
//! handle to report -- Hyprland does not expose the shape -- so those fields
//! are null and the editor draws its default pointer.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use napi_derive::napi;
use serde_json::{json, Value};

/// Long enough for a busy compositor, short enough that a hung one cannot
/// stall the 60 Hz sampler for more than a frame or two.
const IPC_TIMEOUT: Duration = Duration::from_millis(50);

fn now_epoch_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|elapsed| elapsed.as_millis() as u64)
    .unwrap_or(0)
}

fn hyprland_socket() -> Result<PathBuf, String> {
  let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE")
    .map_err(|_| "not running under Hyprland".to_string())?;
  let runtime = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".to_string());
  let primary = PathBuf::from(&runtime)
    .join("hypr")
    .join(&signature)
    .join(".socket.sock");
  if primary.exists() {
    return Ok(primary);
  }
  // Hyprland before 0.40 kept its sockets under /tmp.
  let legacy = PathBuf::from("/tmp/hypr").join(&signature).join(".socket.sock");
  if legacy.exists() {
    return Ok(legacy);
  }
  Err(format!("Hyprland socket not found at {}", primary.display()))
}

/// One request/response round trip on the control socket.
fn hyprland_request(command: &str) -> Result<Value, String> {
  let mut stream =
    UnixStream::connect(hyprland_socket()?).map_err(|error| format!("Hyprland socket: {error}"))?;
  stream
    .set_read_timeout(Some(IPC_TIMEOUT))
    .and_then(|()| stream.set_write_timeout(Some(IPC_TIMEOUT)))
    .map_err(|error| format!("Hyprland socket: {error}"))?;
  stream
    .write_all(command.as_bytes())
    .map_err(|error| format!("Hyprland socket write: {error}"))?;
  let mut reply = String::new();
  stream
    .read_to_string(&mut reply)
    .map_err(|error| format!("Hyprland socket read: {error}"))?;
  serde_json::from_str(&reply).map_err(|error| format!("Hyprland sent {reply:?}: {error}"))
}

/// A command whose reply is plain text ("ok" or an error), not JSON.
///
/// Hyprland serves its control socket on the compositor's main loop and, once
/// it accepts a connection, blocks in `poll()` until the command arrives. A
/// client that connects and writes later -- an async socket in a busy event
/// loop -- freezes the whole desktop for that gap, so connect and write here
/// happen back to back.
fn hyprland_command(command: &str) -> Result<String, String> {
  let mut stream =
    UnixStream::connect(hyprland_socket()?).map_err(|error| format!("Hyprland socket: {error}"))?;
  stream
    .set_read_timeout(Some(IPC_TIMEOUT))
    .and_then(|()| stream.set_write_timeout(Some(IPC_TIMEOUT)))
    .map_err(|error| format!("Hyprland socket: {error}"))?;
  stream
    .write_all(command.as_bytes())
    .map_err(|error| format!("Hyprland socket write: {error}"))?;
  let mut reply = String::new();
  stream
    .read_to_string(&mut reply)
    .map_err(|error| format!("Hyprland socket read: {error}"))?;
  Ok(reply)
}

const NO_HARDWARE_CURSORS: &str = "cursor:no_hardware_cursors";

/// Set `cursor:no_hardware_cursors`. Hyprland's Lua config (0.55 and later)
/// only takes `eval`; the older hyprlang config only takes `keyword`.
fn set_no_hardware_cursors(value: i64) -> Result<(), String> {
  let lua = format!("eval hl.config({{ cursor = {{ no_hardware_cursors = {value} }} }})");
  let reply = hyprland_command(&lua)?;
  if reply.trim() == "ok" {
    return Ok(());
  }
  let reply = hyprland_command(&format!("keyword {NO_HARDWARE_CURSORS} {value}"))?;
  if reply.trim() == "ok" {
    Ok(())
  } else {
    Err(format!("Hyprland would not set {NO_HARDWARE_CURSORS}: {}", reply.trim()))
  }
}

/// Hardware cursors for as long as this is held, then the user's setting back.
///
/// Hyprland paints a software cursor into the frame itself, and screen
/// capture copies that frame, so the portal's "hide the cursor" cannot take
/// it out again -- the recording would show it under recso's own cursor.
/// Hyprland picks software cursors on its own on NVIDIA machines with more
/// than one GPU (`no_hardware_cursors = 2`, "auto"), so a hybrid laptop hits
/// this out of the box. A hardware cursor lives on its own display plane and
/// never reaches the captured frame.
///
/// The change is runtime-only: nothing is written to the user's config, and
/// a config reload undoes it too.
pub(crate) struct HardwareCursor {
  restore: Option<i64>,
}

impl HardwareCursor {
  /// Does nothing off Hyprland, or when hardware cursors are already forced.
  pub(crate) fn acquire() -> Self {
    let current = match hyprland_request(&format!("j/getoption {NO_HARDWARE_CURSORS}")) {
      Ok(value) => value.get("int").and_then(Value::as_i64),
      Err(_) => None,
    };
    let Some(current) = current.filter(|value| *value != 0) else {
      return Self { restore: None };
    };
    if let Err(error) = set_no_hardware_cursors(0) {
      eprintln!("[velocity] {error}; the recording will show Hyprland's own cursor");
      return Self { restore: None };
    }
    if let Some(monitors) = hyprland_request("j/monitors")
      .ok()
      .and_then(|value| value.as_array().cloned())
    {
      for monitor in monitors {
        if monitor.get("hardwareCursorsInUse").and_then(Value::as_bool) == Some(false) {
          let name = monitor.get("name").and_then(Value::as_str).unwrap_or("?");
          eprintln!("[velocity] {name} still draws a software cursor; recordings of it will show that cursor");
        }
      }
    }
    Self {
      restore: Some(current),
    }
  }
}

impl Drop for HardwareCursor {
  fn drop(&mut self) {
    if let Some(value) = self.restore.take() {
      if let Err(error) = set_no_hardware_cursors(value) {
        eprintln!("[velocity] could not restore {NO_HARDWARE_CURSORS} = {value}: {error}");
      }
    }
  }
}

/// A monitor's layout rectangle and scale, as Hyprland reports it.
#[derive(Clone, Copy, Debug, PartialEq)]
struct MonitorLayout {
  x: f64,
  y: f64,
  /// Logical size: the pixel size divided by the scale.
  width: f64,
  height: f64,
  scale: f64,
}

fn parse_monitors(value: &Value) -> Vec<MonitorLayout> {
  value
    .as_array()
    .map(|monitors| {
      monitors
        .iter()
        .filter_map(|monitor| {
          let scale = monitor.get("scale")?.as_f64().filter(|scale| *scale > 0.0)?;
          Some(MonitorLayout {
            x: monitor.get("x")?.as_f64()?,
            y: monitor.get("y")?.as_f64()?,
            width: monitor.get("width")?.as_f64()? / scale,
            height: monitor.get("height")?.as_f64()? / scale,
            scale,
          })
        })
        .collect()
    })
    .unwrap_or_default()
}

/// Hyprland's logical layout position to the physical pixels the recorder
/// normalises against.
///
/// The recorder scales each display's DIP bounds by that display's own scale
/// factor, so a position is scaled by the scale of the monitor it is on. Off
/// every monitor (mid-drag between them) falls back to the first one's scale.
fn to_physical(x: f64, y: f64, monitors: &[MonitorLayout]) -> (f64, f64) {
  let containing = monitors.iter().find(|monitor| {
    x >= monitor.x && x < monitor.x + monitor.width && y >= monitor.y && y < monitor.y + monitor.height
  });
  let scale = containing
    .or_else(|| monitors.first())
    .map(|monitor| monitor.scale)
    .unwrap_or(1.0);
  (x * scale, y * scale)
}

/// How long a fetched monitor layout is reused. Every request stalls
/// Hyprland's main loop for its round trip, and the layout almost never
/// changes during a recording, so the sampler asks for it about once a second
/// instead of with every position.
const MONITORS_TTL: Duration = Duration::from_secs(1);

struct MonitorCache {
  fetched: Option<(Instant, Vec<MonitorLayout>)>,
}

impl MonitorCache {
  fn get(&mut self, now: Instant, fetch: impl FnOnce() -> Vec<MonitorLayout>) -> Vec<MonitorLayout> {
    if let Some((at, monitors)) = &self.fetched {
      if now.duration_since(*at) < MONITORS_TTL {
        return monitors.clone();
      }
    }
    let monitors = fetch();
    self.fetched = Some((now, monitors.clone()));
    monitors
  }
}

static MONITORS: Mutex<MonitorCache> = Mutex::new(MonitorCache { fetched: None });

fn cursor_position() -> Result<(i64, i64), String> {
  let position = hyprland_request("j/cursorpos")?;
  let x = position
    .get("x")
    .and_then(Value::as_f64)
    .ok_or("Hyprland cursorpos had no x")?;
  let y = position
    .get("y")
    .and_then(Value::as_f64)
    .ok_or("Hyprland cursorpos had no y")?;
  let monitors = MONITORS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .get(Instant::now(), || {
      hyprland_request("j/monitors")
        .map(|value| parse_monitors(&value))
        .unwrap_or_default()
    });
  let (x, y) = to_physical(x, y, &monitors);
  Ok((x.round() as i64, y.round() as i64))
}

fn snapshot_value() -> Value {
  let captured_at_epoch_ms = now_epoch_ms();
  match cursor_position() {
    Ok((x, y)) => json!({
      "capturedAtEpochMs": captured_at_epoch_ms,
      "cursorInfo": {
        "ok": true,
        "error": null,
        "isShowing": true,
        "hCursorHex": null,
        "systemCursorGuess": null,
        "cursorImage": null,
        "screenPos": { "x": x, "y": y },
      },
      "cursorPos": { "ok": true, "error": null, "screenPos": { "x": x, "y": y } },
      "windowUnderCursor": null,
    }),
    Err(error) => json!({
      "capturedAtEpochMs": captured_at_epoch_ms,
      "cursorInfo": { "ok": false, "error": error, "screenPos": null, "cursorImage": null },
      "cursorPos": { "ok": false, "error": error, "screenPos": null },
      "windowUnderCursor": null,
    }),
  }
}

/// Linux only: one command on Hyprland's control socket, and its reply as text.
///
/// For the app's Hyprland IPC (click capture): a blocking round trip that
/// never leaves the compositor waiting on the caller's event loop.
#[napi]
pub fn hyprland_ipc(command: String) -> napi::Result<String> {
  hyprland_command(&command).map_err(napi::Error::from_reason)
}

#[napi]
pub fn is_cursor_settings_supported() -> napi::Result<bool> {
  Ok(false)
}

#[napi]
pub fn capture_cursor_snapshot_json() -> napi::Result<String> {
  serde_json::to_string_pretty(&snapshot_value())
    .map_err(|err| napi::Error::from_reason(format!("Failed to serialize cursor snapshot: {err}")))
}

#[napi]
pub fn capture_cursor_samples_json(
  duration_ms: u32,
  interval_ms: Option<u32>,
) -> napi::Result<String> {
  let clamped_duration_ms = duration_ms.clamp(20, 60_000);
  let clamped_interval_ms = interval_ms.unwrap_or(16).clamp(1, 1_000);

  let start = Instant::now();
  let mut samples = Vec::new();
  loop {
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let mut snapshot = snapshot_value();
    if let Some(map) = snapshot.as_object_mut() {
      map.insert("tMs".to_string(), json!(elapsed_ms));
    }
    samples.push(snapshot);
    if elapsed_ms >= clamped_duration_ms as u64 {
      break;
    }
    thread::sleep(Duration::from_millis(clamped_interval_ms as u64));
  }

  serde_json::to_string_pretty(&json!({
    "durationMs": clamped_duration_ms,
    "intervalMs": clamped_interval_ms,
    "sampleCount": samples.len(),
    "samples": samples,
  }))
  .map_err(|err| napi::Error::from_reason(format!("Failed to serialize cursor samples: {err}")))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn monitor(x: f64, y: f64, width: f64, height: f64, scale: f64) -> MonitorLayout {
    MonitorLayout {
      x,
      y,
      width,
      height,
      scale,
    }
  }

  fn no_hardware_cursors() -> Option<i64> {
    hyprland_request(&format!("j/getoption {NO_HARDWARE_CURSORS}"))
      .ok()?
      .get("int")?
      .as_i64()
  }

  #[test]
  #[ignore = "changes the running Hyprland's cursor setting for a moment; run with --ignored"]
  fn a_recording_holds_hardware_cursors_and_gives_the_setting_back() {
    let before = no_hardware_cursors().expect("running under Hyprland");
    let guard = HardwareCursor::acquire();
    assert_eq!(no_hardware_cursors(), Some(0));
    let monitors = hyprland_request("j/monitors").expect("monitors");
    for monitor in monitors.as_array().expect("a list") {
      assert_eq!(monitor.get("hardwareCursorsInUse"), Some(&json!(true)), "{monitor}");
    }
    drop(guard);
    assert_eq!(no_hardware_cursors(), Some(before));
  }

  #[test]
  fn the_monitor_layout_is_fetched_once_a_second() {
    let mut cache = MonitorCache { fetched: None };
    let start = Instant::now();
    let mut fetches = 0;
    let mut fetch = || {
      fetches += 1;
      vec![monitor(0.0, 0.0, 1536.0, 864.0, 1.25)]
    };
    assert_eq!(cache.get(start, &mut fetch).len(), 1);
    assert_eq!(cache.get(start + Duration::from_millis(999), &mut fetch).len(), 1);
    assert_eq!(cache.get(start + MONITORS_TTL, &mut fetch).len(), 1);
    assert_eq!(fetches, 2);
  }

  #[test]
  fn monitor_sizes_are_logical() {
    let value = json!([{ "x": 0, "y": 0, "width": 1920, "height": 1080, "scale": 1.25 }]);
    assert_eq!(
      parse_monitors(&value),
      vec![monitor(0.0, 0.0, 1536.0, 864.0, 1.25)]
    );
  }

  #[test]
  fn a_monitor_without_a_usable_scale_is_skipped() {
    let value = json!([{ "x": 0, "y": 0, "width": 1920, "height": 1080, "scale": 0 }]);
    assert!(parse_monitors(&value).is_empty());
  }

  #[test]
  fn a_position_is_scaled_by_its_own_monitor() {
    let monitors = [
      monitor(0.0, 0.0, 1536.0, 864.0, 1.25),
      monitor(1536.0, 0.0, 1920.0, 1080.0, 1.0),
    ];
    assert_eq!(to_physical(100.0, 100.0, &monitors), (125.0, 125.0));
    assert_eq!(to_physical(2000.0, 100.0, &monitors), (2000.0, 100.0));
  }

  #[test]
  fn off_every_monitor_falls_back_to_the_first_scale() {
    let monitors = [monitor(0.0, 0.0, 1536.0, 864.0, 1.25)];
    assert_eq!(to_physical(-10.0, 0.0, &monitors), (-12.5, 0.0));
  }

  #[test]
  fn no_monitor_list_leaves_the_position_alone() {
    assert_eq!(to_physical(10.0, 20.0, &[]), (10.0, 20.0));
  }
}
