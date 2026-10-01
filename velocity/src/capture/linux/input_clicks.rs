//! Button presses for Wayland recordings that receive no global click events.
//!
//! GNOME and KDE do not expose global clicks to the app. We read evdev pointer
//! devices when the user already has access; the access check only reports
//! whether they can be read and never requests privileges.

use std::collections::VecDeque;
use std::ffi::CString;
use std::fs;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

use super::cursor_meta::{self, CursorPoint};

const MAX_PENDING: usize = 256;
const EVENTS_PER_READ: usize = 64;

struct Capture {
  stop: Arc<AtomicBool>,
  thread: JoinHandle<()>,
}

/// A button press waiting for `drain`.
pub(crate) struct PendingClick {
  /// "left", "right" or "middle".
  pub(crate) button: &'static str,
  /// Wall-clock time, ms since the Unix epoch.
  pub(crate) at_epoch_ms: f64,
  /// The pointer as a fraction of the recorded frame, when available.
  pub(crate) position: Option<CursorPoint>,
}

static CAPTURE: Mutex<Option<Capture>> = Mutex::new(None);
static PENDING: Mutex<VecDeque<PendingClick>> = Mutex::new(VecDeque::new());

/// Pointer devices found, and how many of them recso may read.
type Access = (u32, u32);

fn parse_bitmask(text: &str) -> Vec<u64> {
  text
    .split_whitespace()
    .map(|word| u64::from_str_radix(word, 16).unwrap_or(0))
    .rev()
    .collect()
}

fn has_bit(words: &[u64], bit: u32) -> bool {
  words
    .get((bit / 64) as usize)
    .is_some_and(|word| word & (1_u64 << (bit % 64)) != 0)
}

fn is_pointer(ev: &[u64], key: &[u64]) -> bool {
  has_bit(ev, 1) && has_bit(key, 0x110) && !has_bit(key, 30) && !has_bit(key, 57)
}

fn scan_devices(keep_open: bool) -> (Access, Vec<OwnedFd>) {
  let (mut devices, mut readable) = (0, 0);
  let mut opened = Vec::new();
  let Ok(entries) = fs::read_dir("/sys/class/input") else {
    return ((devices, readable), opened);
  };
  for entry in entries.flatten() {
    let name = entry.file_name();
    let Some(name) = name.to_str() else { continue };
    let Some(number) = name.strip_prefix("event") else {
      continue;
    };
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
      continue;
    }
    let path = entry.path().join("device/capabilities");
    let (Ok(ev), Ok(key)) = (
      fs::read_to_string(path.join("ev")),
      fs::read_to_string(path.join("key")),
    ) else {
      continue;
    };
    if !is_pointer(&parse_bitmask(&ev), &parse_bitmask(&key)) {
      continue;
    }
    let Ok(device_path) = CString::new(format!("/dev/input/{name}")) else {
      continue;
    };
    // SAFETY: `device_path` is a valid NUL-terminated path for this call.
    let raw_fd = unsafe {
      libc::open(
        device_path.as_ptr(),
        libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
      )
    };
    if raw_fd >= 0 {
      devices += 1;
      readable += 1;
      // SAFETY: This descriptor just came from a successful open and is owned here.
      let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
      if keep_open {
        opened.push(fd);
      }
    } else if matches!(
      std::io::Error::last_os_error().raw_os_error(),
      Some(libc::EACCES | libc::EPERM)
    ) {
      devices += 1;
    }
  }
  ((devices, readable), opened)
}

fn click_button(kind: u16, code: u16, value: i32) -> Option<&'static str> {
  if kind != 1 || value != 1 {
    return None;
  }
  match code {
    0x110 => Some("left"),
    0x111 => Some("right"),
    0x112 => Some("middle"),
    _ => None,
  }
}

fn push_click(queue: &mut VecDeque<PendingClick>, click: PendingClick) {
  if queue.len() >= MAX_PENDING {
    queue.pop_front();
  }
  queue.push_back(click);
}

fn record_click(button: &'static str) {
  let at_epoch_ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs_f64() * 1_000.0)
    .unwrap_or(0.0);
  let click = PendingClick {
    button,
    at_epoch_ms,
    position: cursor_meta::active_position(),
  };
  push_click(
    &mut PENDING.lock().unwrap_or_else(|e| e.into_inner()),
    click,
  );
}

fn read_available(fd: &OwnedFd, stop: &AtomicBool) -> bool {
  let mut buffer = [std::mem::MaybeUninit::<libc::input_event>::uninit(); EVENTS_PER_READ];
  let event_size = std::mem::size_of::<libc::input_event>();
  loop {
    if stop.load(Ordering::Relaxed) {
      return false;
    }
    // SAFETY: `buffer` has room for all bytes requested, and the fd remains open.
    let bytes = unsafe {
      libc::read(
        fd.as_raw_fd(),
        buffer.as_mut_ptr().cast(),
        std::mem::size_of_val(&buffer),
      )
    };
    if bytes < 0 {
      return match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::EAGAIN) => false,
        Some(libc::EINTR) => false,
        Some(libc::ENODEV | libc::EIO) => true,
        _ => true,
      };
    }
    if bytes == 0 {
      return true;
    }
    for item in buffer.iter().take(bytes as usize / event_size) {
      // SAFETY: read initialized every byte of each complete event in this range.
      let event = unsafe { item.assume_init_ref() };
      if let Some(button) = click_button(event.type_, event.code, event.value) {
        record_click(button);
      }
    }
    if (bytes as usize) < std::mem::size_of_val(&buffer) {
      continue;
    }
  }
}

fn run_capture(mut devices: Vec<OwnedFd>, stop: Arc<AtomicBool>) {
  while !stop.load(Ordering::Relaxed) && !devices.is_empty() {
    let mut pollfds: Vec<libc::pollfd> = devices
      .iter()
      .map(|fd| libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
      })
      .collect();
    // SAFETY: `pollfds` is a live array of valid pollfd values for this call.
    let result = unsafe { libc::poll(pollfds.as_mut_ptr(), pollfds.len() as libc::nfds_t, 100) };
    if stop.load(Ordering::Relaxed) {
      break;
    }
    if result < 0 {
      if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
        continue;
      }
      break;
    }
    let mut remove = vec![false; devices.len()];
    for (index, pollfd) in pollfds.iter().enumerate() {
      if pollfd.revents & libc::POLLIN != 0 && read_available(&devices[index], &stop) {
        remove[index] = true;
      }
      if pollfd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
        remove[index] = true;
      }
    }
    let mut index = 0;
    devices.retain(|_| {
      let keep = !remove[index];
      index += 1;
      keep
    });
  }
}

/// Count the mouse and touchpad devices, and how many recso can read now.
/// Each opened device is closed again; this does not start capture.
pub(crate) fn access() -> Access {
  scan_devices(false).0
}

/// Stop any running capture, then read clicks from the readable mouse and
/// touchpad devices on a background thread.
pub(crate) fn start() -> Access {
  stop();
  let (access, devices) = scan_devices(true);
  if devices.is_empty() {
    return access;
  }
  let stop = Arc::new(AtomicBool::new(false));
  let thread_stop = stop.clone();
  if let Ok(thread) = thread::Builder::new()
    .name("velocity-input-clicks".to_string())
    .spawn(move || run_capture(devices, thread_stop))
  {
    *CAPTURE.lock().unwrap_or_else(|e| e.into_inner()) = Some(Capture { stop, thread });
  }
  access
}

/// Take the clicks seen since the last call, oldest first.
pub(crate) fn drain() -> Vec<PendingClick> {
  std::mem::take(&mut *PENDING.lock().unwrap_or_else(|e| e.into_inner())).into()
}

/// Stop reading clicks, close the devices, and drop pending clicks.
pub(crate) fn stop() {
  let capture = CAPTURE.lock().unwrap_or_else(|e| e.into_inner()).take();
  if let Some(capture) = capture {
    capture.stop.store(true, Ordering::Relaxed);
    let _ = capture.thread.join();
  }
  PENDING.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn bitmasks_identify_pointer_buttons_and_exclude_keyboard_keys() {
    let key = parse_bitmask("70000 0 0 0 0");
    for bit in [0x110, 0x111, 0x112] {
      assert!(has_bit(&key, bit));
    }
    assert!(!has_bit(&key, 30));
    for text in ["0", ""] {
      let words = parse_bitmask(text);
      for bit in 0..=300 {
        assert!(!has_bit(&words, bit));
      }
    }
    let ev = parse_bitmask("17");
    assert!(is_pointer(&ev, &key));
    let mut keyboard = key.clone();
    keyboard[0] = (1 << 30) | (1 << 57);
    assert!(!is_pointer(&ev, &keyboard));
    assert!(!is_pointer(&parse_bitmask("15"), &key));
  }

  #[test]
  fn only_mouse_button_presses_become_clicks() {
    for (code, name) in [(0x110, "left"), (0x111, "right"), (0x112, "middle")] {
      assert_eq!(click_button(1, code, 1), Some(name));
      assert_eq!(click_button(1, code, 0), None);
      assert_eq!(click_button(1, code, 2), None);
    }
    assert_eq!(click_button(2, 0x110, 1), None);
    assert_eq!(click_button(1, 0x14a, 1), None);
  }

  #[test]
  fn pending_clicks_drop_the_oldest_when_full() {
    let mut queue = VecDeque::new();
    for index in 0..300 {
      push_click(
        &mut queue,
        PendingClick {
          button: "left",
          at_epoch_ms: index as f64,
          position: None,
        },
      );
    }
    assert_eq!(queue.len(), 256);
    assert_eq!(queue.front().map(|click| click.at_epoch_ms), Some(44.0));
  }

  #[test]
  fn access_check_runs_without_needing_input_permission() {
    let (devices, readable) = access();
    println!("devices={devices}, readable={readable}");
    assert!(readable <= devices);
  }
}
