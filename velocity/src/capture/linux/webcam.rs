//! Linux webcam preview and sidecar recording.
//!
//! V4L2 owns the local camera on a worker thread. Both local and paired-phone
//! frames enter the same preview and MP4 path, stamped with the screen clock so
//! the editor can place the two files at one origin.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, RgbImage};
use napi_derive::napi;
use v4l::buffer::Type;
use v4l::capability::Flags;
use v4l::format::{Format, FourCC};
use v4l::fraction::Fraction;
use v4l::frameinterval::FrameIntervalEnum;
use v4l::io::mmap::Stream;
use v4l::io::traits::CaptureStream;
use v4l::video::capture::Parameters;
use v4l::video::Capture;
use v4l::Device;

use super::super::camera::{camera_sidecar_path, target_webcam_fps};
use super::super::devices::WebcamDeviceInfo;
use super::super::phone_camera;
use super::super::preview::{
  clear_webcam_preview_frame, preview_frame_slot, StoredWebcamPreviewFrame, WEBCAM_PREVIEW_SEQUENCE,
};
use super::super::recording_info::RecordingStats;
use super::super::stopper::Stopper;
use super::super::WebcamSource;
use super::encoder::{Mp4Recorder, PixelOrder, VideoSettings};

const STARTUP: Duration = Duration::from_secs(5);
const PREVIEW_PERIOD: Duration = Duration::from_millis(80);
const RETRY_PERIOD: Duration = Duration::from_millis(3);
static WEBCAM_PREVIEW_RUNNING: AtomicBool = AtomicBool::new(false);

/// Enumerate capture nodes in numeric order, excluding adjacent metadata nodes.
fn capture_nodes() -> Vec<(String, String)> {
  let mut paths: Vec<(u32, PathBuf)> = std::fs::read_dir("/dev")
    .ok()
    .into_iter()
    .flat_map(|entries| entries.filter_map(Result::ok))
    .filter_map(|entry| {
      let name = entry.file_name();
      let number = name.to_str()?.strip_prefix("video")?.parse::<u32>().ok()?;
      Some((number, entry.path()))
    })
    .collect();
  paths.sort_by_key(|(number, _)| *number);
  paths
    .into_iter()
    .filter_map(|(_, path)| {
      let dev = Device::with_path(&path).ok()?;
      let caps = dev.query_caps().ok()?;
      caps.capabilities.contains(Flags::VIDEO_CAPTURE).then(|| {
        (
          path.to_string_lossy().into_owned(),
          caps.card.trim().to_string(),
        )
      })
    })
    .collect()
}

/// Cameras available to the recorder's local-device picker.
#[napi]
pub fn list_webcam_devices() -> Vec<WebcamDeviceInfo> {
  capture_nodes()
    .into_iter()
    .enumerate()
    .map(|(index, (id, card))| WebcamDeviceInfo {
      id,
      label: if card.is_empty() {
        format!("Camera {}", index + 1)
      } else {
        card
      },
      is_default: index == 0,
    })
    .collect()
}

struct Camera {
  dev: Device,
  format: Format,
  fps: u32,
}

/// Negotiate once and keep the driver's returned geometry and cadence.
fn open_camera(id: Option<&str>, target_fps: u32) -> Result<Camera, String> {
  let nodes = capture_nodes();
  let path = match id {
    Some(id) => nodes
      .iter()
      .find(|(path, _)| path == id)
      .map(|(path, _)| path),
    None => nodes.first().map(|(path, _)| path),
  }
  .ok_or_else(|| match id {
    Some(id) => format!("requested webcam device '{id}' was not found"),
    None => "no webcam devices available".to_string(),
  })?;
  let dev = Device::with_path(path).map_err(|e| format!("failed to open webcam {path}: {e}"))?;
  let offered = dev
    .enum_formats()
    .map_err(|e| format!("list webcam formats: {e}"))?;
  let fourcc = [FourCC::new(b"MJPG"), FourCC::new(b"YUYV")]
    .into_iter()
    .find(|candidate| offered.iter().any(|format| format.fourcc == *candidate))
    .ok_or("webcam offers neither MJPG nor YUYV")?;
  let sizes = dev
    .enum_framesizes(fourcc)
    .map_err(|e| format!("list webcam sizes: {e}"))?;
  let sizes: Vec<_> = sizes
    .into_iter()
    .flat_map(|size| size.size.to_discrete())
    .collect();
  let area = |size: &v4l::framesize::Discrete| u64::from(size.width) * u64::from(size.height);
  let selected = sizes
    .iter()
    .filter(|size| area(size) <= 1280 * 720)
    .max_by_key(|size| area(size))
    .or_else(|| sizes.iter().min_by_key(|size| area(size)))
    .ok_or("webcam offers no frame sizes")?;
  let format = dev
    .set_format(&Format::new(selected.width, selected.height, fourcc))
    .map_err(|e| format!("set webcam format: {e}"))?;
  if format.fourcc != FourCC::new(b"MJPG") && format.fourcc != FourCC::new(b"YUYV") {
    return Err(format!(
      "webcam selected unsupported format {}",
      format.fourcc
    ));
  }
  let intervals = dev
    .enum_frameintervals(format.fourcc, format.width, format.height)
    .unwrap_or_default();
  let chosen = intervals
    .into_iter()
    .filter_map(|entry| match entry.interval {
      FrameIntervalEnum::Discrete(frac) if frac.numerator > 0 && frac.denominator > 0 => Some(frac),
      _ => None,
    })
    .filter(|frac| u64::from(frac.denominator) <= u64::from(target_fps) * u64::from(frac.numerator))
    .max_by(|a, b| {
      (u64::from(a.denominator) * u64::from(b.numerator))
        .cmp(&(u64::from(b.denominator) * u64::from(a.numerator)))
    })
    .unwrap_or_else(|| Fraction::new(1, target_fps.max(1)));
  dev
    .set_params(&Parameters::new(chosen))
    .map_err(|e| format!("set webcam fps: {e}"))?;
  let actual = dev
    .params()
    .map_err(|e| format!("read webcam fps: {e}"))?
    .interval;
  let fps = if actual.numerator > 0 {
    (actual.denominator / actual.numerator).max(1)
  } else {
    target_fps.max(1)
  };
  Ok(Camera { dev, format, fps })
}

struct Frame {
  rgb: Vec<u8>,
  width: usize,
  height: usize,
  pts: i64,
}

/// Decode only complete frames; a corrupt first JPEG is common on UVC devices.
fn next_local_frame(stream: &mut Stream<'_>, format: Format) -> Result<Option<Frame>, String> {
  let (bytes, meta) = match stream.next() {
    Ok(frame) => frame,
    Err(e) if e.kind() == ErrorKind::WouldBlock => return Ok(None),
    Err(e) => return Err(format!("capture failed: {e}")),
  };
  let bytes = &bytes[..bytes.len().min(meta.bytesused as usize)];
  let width = format.width as usize;
  let height = format.height as usize;
  let rgb = if format.fourcc == FourCC::new(b"MJPG") {
    match image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg) {
      Ok(image) => {
        let rgb = image.to_rgb8();
        return Ok(Some(Frame {
          width: rgb.width() as usize,
          height: rgb.height() as usize,
          rgb: rgb.into_raw(),
          pts: super::screen::now_100ns(Instant::now()),
        }));
      }
      Err(_) => return Ok(None),
    }
  } else {
    let stride = (format.stride as usize).max(width.saturating_mul(2));
    if bytes.len() < stride.saturating_mul(height) {
      return Ok(None);
    }
    let mut rgb = Vec::with_capacity(width.saturating_mul(height).saturating_mul(3));
    for row in bytes.chunks_exact(stride).take(height) {
      rgb.extend_from_slice(&yuyv_to_rgb(row, width, 1));
    }
    rgb
  };
  Ok(Some(Frame {
    rgb,
    width,
    height,
    pts: super::screen::now_100ns(Instant::now()),
  }))
}

fn clamp(value: i32) -> u8 {
  value.clamp(0, 255) as u8
}

/// BT.601 studio-range YUYV; any trailing incomplete two-pixel pair stays black.
fn yuyv_to_rgb(src: &[u8], width: usize, height: usize) -> Vec<u8> {
  let mut out = vec![0; width.saturating_mul(height).saturating_mul(3)];
  for (row, target) in src
    .chunks(width.saturating_mul(2).max(1))
    .take(height)
    .zip(out.chunks_mut(width.saturating_mul(3).max(1)))
  {
    for (pair, pixels) in row.chunks_exact(4).zip(target.chunks_exact_mut(6)) {
      let u = pair[1] as i32 - 128;
      let v = pair[3] as i32 - 128;
      let (first, second) = pixels.split_at_mut(3);
      for (y, rgb) in [(pair[0], first), (pair[2], second)].into_iter() {
        let c = (y as i32 - 16).max(0);
        rgb[0] = clamp((298 * c + 409 * v + 128) >> 8);
        rgb[1] = clamp((298 * c - 100 * u - 208 * v + 128) >> 8);
        rgb[2] = clamp((298 * c + 516 * u + 128) >> 8);
      }
    }
  }
  out
}

/// Put the phone's bottom-up rows in the orientation expected by the encoder.
fn flip_bgra_rows(src: &[u8], width: usize, height: usize) -> Option<Vec<u8>> {
  let row = width.checked_mul(4)?;
  let len = row.checked_mul(height)?;
  if width == 0 || height == 0 || src.len() < len {
    return None;
  }
  let mut out = vec![0; len];
  for y in 0..height {
    out[y * row..(y + 1) * row].copy_from_slice(&src[(height - y - 1) * row..(height - y) * row]);
  }
  Some(out)
}

/// Keep the source aspect ratio and never enlarge an already small image.
fn preview_size(width: u32, height: u32) -> (u32, u32) {
  if width == 0 || height == 0 {
    return (0, 0);
  }
  if width <= 480 && height <= 360 {
    return (width, height);
  }
  let scale = (480.0 / width as f64).min(360.0 / height as f64);
  (
    (width as f64 * scale).round().max(1.0) as u32,
    (height as f64 * scale).round().max(1.0) as u32,
  )
}

fn publish_preview(rgb: &[u8], width: usize, height: usize) -> Result<(), String> {
  let width = u32::try_from(width).map_err(|e| e.to_string())?;
  let height = u32::try_from(height).map_err(|e| e.to_string())?;
  let source =
    RgbImage::from_raw(width, height, rgb.to_vec()).ok_or("invalid webcam preview pixels")?;
  let (w, h) = preview_size(width, height);
  let image = if (w, h) == (width, height) {
    source
  } else {
    image::imageops::resize(&source, w, h, FilterType::Triangle)
  };
  let mut jpeg = Vec::new();
  JpegEncoder::new_with_quality(&mut jpeg, 76)
    .encode(image.as_raw(), w, h, ExtendedColorType::Rgb8)
    .map_err(|e| format!("encode webcam preview: {e}"))?;
  let sequence = WEBCAM_PREVIEW_SEQUENCE
    .fetch_add(1, Ordering::Relaxed)
    .wrapping_add(1);
  let mut slot = preview_frame_slot()
    .lock()
    .map_err(|_| "webcam preview lock poisoned")?;
  *slot = Some(StoredWebcamPreviewFrame {
    jpeg,
    width: w,
    height: h,
    sequence,
  });
  Ok(())
}

struct PreviewPublisher {
  last: Option<Instant>,
}
impl PreviewPublisher {
  fn new() -> Self {
    Self { last: None }
  }
  fn publish(&mut self, rgb: &[u8], width: usize, height: usize) -> Result<(), String> {
    if self.last.is_some_and(|at| at.elapsed() < PREVIEW_PERIOD) {
      return Ok(());
    }
    publish_preview(rgb, width, height)?;
    self.last = Some(Instant::now());
    Ok(())
  }
}

struct PreviewGuard;
impl Drop for PreviewGuard {
  fn drop(&mut self) {
    WEBCAM_PREVIEW_RUNNING.store(false, Ordering::Release);
  }
}

fn stopped(stop: &Receiver<()>) -> bool {
  matches!(stop.try_recv(), Ok(()) | Err(TryRecvError::Disconnected))
}

fn preview_loop(id: Option<String>, stop: Receiver<()>, ready: Sender<Result<(), String>>) {
  let _guard = PreviewGuard;
  let camera = match open_camera(id.as_deref(), 30) {
    Ok(camera) => camera,
    Err(e) => {
      let _ = ready.send(Err(e));
      return;
    }
  };
  let mut stream = match Stream::with_buffers(&camera.dev, Type::VideoCapture, 4) {
    Ok(stream) => stream,
    Err(e) => {
      let _ = ready.send(Err(format!("open webcam stream: {e}")));
      return;
    }
  };
  let deadline = Instant::now() + STARTUP;
  let mut ready = Some(ready);
  let mut publisher = PreviewPublisher::new();
  while !stopped(&stop) {
    match next_local_frame(&mut stream, camera.format) {
      Ok(Some(frame)) => {
        if let Err(e) = publisher.publish(&frame.rgb, frame.width, frame.height) {
          if let Some(tx) = ready.take() {
            let _ = tx.send(Err(e));
          }
          break;
        }
        if let Some(tx) = ready.take() {
          let _ = tx.send(Ok(()));
        }
      }
      Ok(None) => thread::sleep(RETRY_PERIOD),
      Err(e) => {
        if let Some(tx) = ready.take() {
          let _ = tx.send(Err(e));
        }
        break;
      }
    }
    if ready.is_some() && Instant::now() >= deadline {
      if let Some(tx) = ready.take() {
        let _ = tx.send(Err("no camera frame decoded within 5s".into()));
      }
      break;
    }
  }
}

/// Start the setup preview once its first JPEG is already available to JS.
#[napi]
pub fn start_webcam_preview(device_id: Option<String>) -> napi::Result<Stopper> {
  if WEBCAM_PREVIEW_RUNNING
    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
    .is_err()
  {
    return Err(napi::Error::from_reason(
      "a native webcam preview is already running",
    ));
  }
  clear_webcam_preview_frame();
  let (stop_tx, stop_rx) = channel();
  let (done_tx, done_rx) = channel();
  let (ready_tx, ready_rx) = channel();
  thread::spawn(move || {
    preview_loop(device_id, stop_rx, ready_tx);
    let _ = done_tx.send(());
  });
  match ready_rx.recv_timeout(Duration::from_secs(8)) {
    Ok(Ok(())) => Ok(Stopper::from_channels(stop_tx, done_rx)),
    result => {
      let _ = stop_tx.send(());
      let _ = done_rx.recv_timeout(Duration::from_secs(2));
      let reason = match result {
        Ok(Err(e)) => e,
        Err(RecvTimeoutError::Timeout) => "startup timed out".into(),
        Err(RecvTimeoutError::Disconnected) => "worker exited during startup".into(),
        Ok(Ok(())) => "startup result changed unexpectedly".into(),
      };
      Err(napi::Error::from_reason(format!(
        "failed to start webcam preview: {reason}"
      )))
    }
  }
}

/// Place the first kept image at the screen origin, then preserve arrival PTS.
fn place_camera_frame(screen_origin: Option<i64>, pts: i64, first_written: bool) -> Vec<i64> {
  match screen_origin {
    None => vec![],
    Some(origin) if pts < origin => vec![],
    Some(origin) if !first_written && pts > origin => vec![origin, pts],
    Some(origin) if !first_written => vec![origin],
    Some(_) => vec![pts],
  }
}

fn rgb_to_rgbx(rgb: &[u8]) -> Vec<u8> {
  let mut out = Vec::with_capacity(rgb.len() / 3 * 4);
  for pixel in rgb.chunks_exact(3) {
    out.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
  }
  out
}

struct EncodedFrame {
  pixels: Vec<u8>,
  rgb: Vec<u8>,
  width: usize,
  height: usize,
  order: PixelOrder,
  pts: i64,
}

fn run_recording(
  path: String,
  source: WebcamSource,
  requested: u32,
  stats: Arc<RecordingStats>,
  stop: Receiver<()>,
  ready: Sender<Result<(), String>>,
) {
  let deadline = Instant::now() + STARTUP;
  let mut local = match source {
    WebcamSource::Local(id) => match open_camera(id.as_deref(), requested) {
      Ok(camera) => Some(camera),
      Err(e) => {
        let _ = ready.send(Err(e));
        return;
      }
    },
    WebcamSource::Phone => None,
  };
  let fps = local
    .as_ref()
    .map_or(requested.min(30), |camera| camera.fps);
  let mut stream = match local.as_ref() {
    Some(camera) => match Stream::with_buffers(&camera.dev, Type::VideoCapture, 4) {
      Ok(stream) => Some(stream),
      Err(e) => {
        let _ = ready.send(Err(format!("open webcam stream: {e}")));
        return;
      }
    },
    None => None,
  };
  let mut first = true;
  let mut recorder: Option<Mp4Recorder> = None;
  let mut publisher = PreviewPublisher::new();
  let mut ready = Some(ready);
  loop {
    let stopping = stopped(&stop);
    let frame = if let (Some(camera), Some(stream)) = (local.as_ref(), stream.as_mut()) {
      match next_local_frame(stream, camera.format) {
        Ok(Some(frame)) => Some(EncodedFrame {
          pixels: rgb_to_rgbx(&frame.rgb),
          rgb: frame.rgb,
          width: frame.width,
          height: frame.height,
          order: PixelOrder::Rgbx,
          pts: frame.pts,
        }),
        Ok(None) => None,
        Err(e) => {
          if let Some(tx) = ready.take() {
            let _ = tx.send(Err(e.clone()));
          }
          eprintln!("[velocity] webcam capture failed: {e}");
          break;
        }
      }
    } else {
      phone_camera::take_frame().and_then(|(bgra, width, height)| {
        let pixels = flip_bgra_rows(&bgra, width, height)?;
        let mut rgb = Vec::with_capacity(width.saturating_mul(height).saturating_mul(3));
        for px in pixels.chunks_exact(4) {
          rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
        Some(EncodedFrame {
          pixels,
          rgb,
          width,
          height,
          order: PixelOrder::Bgrx,
          pts: super::screen::now_100ns(Instant::now()),
        })
      })
    };
    if let Some(frame) = frame {
      let _ = publisher.publish(&frame.rgb, frame.width, frame.height);
      if recorder.is_none() {
        match Mp4Recorder::create(
          Path::new(&path),
          VideoSettings {
            width: frame.width as u32,
            height: frame.height as u32,
            fps: fps.max(1),
            bitrate: 3_000_000,
          },
          None,
        ) {
          Ok(created) => recorder = Some(created),
          Err(e) => {
            if let Some(tx) = ready.take() {
              let _ = tx.send(Err(format!("failed to initialize webcam encoder: {e}")));
            }
            break;
          }
        }
      }
      if let Some(tx) = ready.take() {
        let _ = tx.send(Ok(()));
      }
      let points = place_camera_frame(stats.first_timestamp_100ns(), frame.pts, !first);
      for pts in points {
        if let Some(active) = recorder.as_mut() {
          if let Err(e) = active.push_frame(
            &frame.pixels,
            frame.width as u32,
            frame.height as u32,
            frame.width * 4,
            frame.order,
            pts,
          ) {
            eprintln!("[velocity] webcam encoding failed: {e}");
            break;
          }
          first = false;
        }
      }
    } else if !stopping {
      thread::sleep(if stream.is_some() {
        RETRY_PERIOD
      } else {
        Duration::from_millis(33)
      });
    }
    if stopping {
      break;
    }
    if ready.is_some() && Instant::now() >= deadline {
      if let Some(tx) = ready.take() {
        let _ = tx.send(Err("webcam stream produced no valid frame".into()));
      }
      break;
    }
  }
  drop(stream);
  local.take();
  if let Some(recorder) = recorder {
    if let Err(e) = recorder.finish() {
      eprintln!("[velocity] webcam finalization failed: {e}");
    }
  }
}

/// Record a video-only MP4 whose first sample shares the screen's time zero.
pub(crate) fn start_webcam_sidecar_recording(
  output_path: &str,
  source: WebcamSource,
  target_fps: Option<u32>,
  screen_stats: Arc<RecordingStats>,
) -> napi::Result<Stopper> {
  let path = camera_sidecar_path(output_path);
  let requested = target_webcam_fps(target_fps);
  let (stop_tx, stop_rx) = channel();
  let (done_tx, done_rx) = channel();
  let (ready_tx, ready_rx) = channel();
  thread::spawn(move || {
    run_recording(path, source, requested, screen_stats, stop_rx, ready_tx);
    let _ = done_tx.send(());
  });
  match ready_rx.recv_timeout(Duration::from_secs(8)) {
    Ok(Ok(())) => Ok(Stopper::from_channels(stop_tx, done_rx)),
    result => {
      let _ = stop_tx.send(());
      let _ = done_rx.recv_timeout(Duration::from_secs(2));
      let reason = match result {
        Ok(Err(e)) => e,
        Err(RecvTimeoutError::Timeout) => "startup timed out".into(),
        Err(RecvTimeoutError::Disconnected) => "worker exited during startup".into(),
        Ok(Ok(())) => "startup result changed unexpectedly".into(),
      };
      Err(napi::Error::from_reason(format!(
        "failed to start webcam: {reason}"
      )))
    }
  }
}

#[cfg(test)]
mod colour_conversion_scenarios {
  use super::*;

  #[test]
  fn yuyv_black_and_white_follow_studio_range() {
    assert_eq!(yuyv_to_rgb(&[16, 128, 16, 128], 2, 1), vec![0; 6]);
    assert_eq!(yuyv_to_rgb(&[235, 128, 235, 128], 2, 1), vec![255; 6]);
  }

  #[test]
  fn yuyv_red_is_close_to_bt601_red() {
    let rgb = yuyv_to_rgb(&[81, 90, 81, 240], 2, 1);
    for pixel in rgb.chunks_exact(3) {
      assert!(
        pixel[0] >= 250 && pixel[1] <= 5 && pixel[2] <= 5,
        "{pixel:?}"
      );
    }
  }

  #[test]
  fn an_incomplete_yuyv_pair_is_left_black_without_panicking() {
    let rgb = yuyv_to_rgb(&[235, 128, 235, 128, 99, 16, 128, 16, 128, 99], 5, 1);
    assert_eq!(&rgb[..6], &[255; 6]);
    assert_eq!(&rgb[12..15], &[0; 3]);
  }

  #[test]
  fn phone_rows_are_flipped_to_top_down() {
    assert_eq!(
      flip_bgra_rows(&[1, 2, 3, 4, 5, 6, 7, 8], 1, 2),
      Some(vec![5, 6, 7, 8, 1, 2, 3, 4])
    );
    assert_eq!(flip_bgra_rows(&[1], 1, 2), None);
  }
}

#[cfg(test)]
mod preview_and_timeline_scenarios {
  use super::*;

  #[test]
  fn preview_fits_the_bounds_without_upscaling() {
    for (source, expected) in [
      ((640, 480), (480, 360)),
      ((1920, 1080), (480, 270)),
      ((240, 180), (240, 180)),
      ((1000, 100), (480, 48)),
      ((100, 1000), (36, 360)),
    ] {
      let actual = preview_size(source.0, source.1);
      assert_eq!(actual, expected);
      assert!(actual.0 <= 480 && actual.1 <= 360);
      assert!(
        ((actual.0 as f64 / actual.1 as f64) - (source.0 as f64 / source.1 as f64)).abs() < 0.02
      );
    }
  }

  #[test]
  fn camera_timestamps_begin_at_the_screen_origin() {
    assert!(place_camera_frame(None, 110, false).is_empty());
    assert!(place_camera_frame(Some(100), 99, false).is_empty());
    assert_eq!(place_camera_frame(Some(100), 110, false), vec![100, 110]);
    assert_eq!(place_camera_frame(Some(100), 100, false), vec![100]);
    assert_eq!(place_camera_frame(Some(100), 120, true), vec![120]);
  }
}

#[cfg(test)]
mod hardware_scenarios {
  use super::*;

  /// There is one camera. Tests that open it take turns, or the second one
  /// fails with EBUSY while the first still holds the device.
  static CAMERA: std::sync::Mutex<()> = std::sync::Mutex::new(());

  fn camera() -> std::sync::MutexGuard<'static, ()> {
    CAMERA.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
  }

  #[test]
  #[ignore = "needs a reachable /dev/video0"]
  fn lists_the_built_in_camera() {
    let _camera = camera();
    let devices = list_webcam_devices();
    assert!(!devices.is_empty());
    assert!(devices[0].id.starts_with("/dev/video"));
  }

  #[test]
  #[ignore = "needs a reachable /dev/video0"]
  fn publishes_a_preview_frame() {
    let _camera = camera();
    let mut stopper = start_webcam_preview(None).expect("preview starts");
    let deadline = Instant::now() + Duration::from_secs(5);
    let frame = loop {
      if let Some(frame) = crate::capture::webcam_preview_frame() {
        break frame;
      }
      assert!(Instant::now() < deadline, "no preview frame");
      thread::sleep(Duration::from_millis(10));
    };
    let image = image::load_from_memory(&frame.jpeg).expect("valid JPEG");
    assert!(image.width() <= 480 && image.height() <= 360);
    stopper.stop();
  }

  #[test]
  #[ignore = "needs a reachable /dev/video0"]
  fn records_a_camera_sidecar_aligned_to_the_screen() {
    let _camera = camera();
    let stats = RecordingStats::new(
      "/tmp/velocity-webcam-test.mp4".into(),
      "webcam",
      30,
      3_000_000,
      "h264",
    );
    stats.note_frame(super::super::screen::now_100ns(Instant::now()));
    let sidecar = Path::new("/tmp/velocity-webcam-test_camera.mp4");
    let _ = std::fs::remove_file(sidecar);
    let mut stopper = start_webcam_sidecar_recording(
      "/tmp/velocity-webcam-test.mp4",
      WebcamSource::Local(None),
      None,
      Arc::new(stats),
    )
    .expect("recording starts");
    thread::sleep(Duration::from_secs(2));
    stopper.stop();
    assert!(sidecar.exists());
    let mut reader =
      mp4::read_mp4(std::fs::File::open(sidecar).expect("sidecar exists")).expect("valid MP4");
    let track = reader.tracks().values().next().expect("video track");
    assert!(
      // Several frames prove the camera kept delivering, not a single frame
      // written twice. Not a rate check: a debug build decodes 720p MJPEG at
      // about 5 fps, a release build at about 16.
      track.sample_count() >= 5,
      "only {} samples",
      track.sample_count()
    );
    let id = *reader.tracks().keys().next().expect("track id");
    assert_eq!(
      reader
        .read_sample(id, 1)
        .expect("sample read")
        .expect("first sample")
        .start_time,
      0
    );
  }
}
