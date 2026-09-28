#[cfg(test)]
use super::camera::advance_stamp;
#[cfg(test)]
use std::path::Path;
use super::camera::{camera_sidecar_path, target_webcam_fps, webcam_stamp};
use super::devices::WebcamDeviceInfo;
use super::pixels::rgb_to_bgra_bottom_up;
use super::preview::{
  clear_webcam_preview_frame, preview_frame_slot, StoredWebcamPreviewFrame, WEBCAM_PREVIEW_SEQUENCE,
};
use super::stopper::Stopper;
use super::WebcamSource;
use super::phone_camera;
use super::recording_info::RecordingStats;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ExtendedColorType, RgbImage};
use napi_derive::napi;
use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{ApiBackend, CameraIndex, RequestedFormat, RequestedFormatType};
use nokhwa::{query, Camera};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::System::Com::{
  CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows_capture::encoder::{
  AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
  VideoSettingsSubType,
};

const WEBCAM_DEFAULT_BITRATE: u32 = 3_000_000;
const WEBCAM_READY_FRAME_TIMEOUT: Duration = Duration::from_secs(5);
const WEBCAM_PREVIEW_FPS: u32 = 30;
const WEBCAM_PREVIEW_PERIOD: Duration = Duration::from_millis(80);
const WEBCAM_PREVIEW_MAX_WIDTH: u32 = 480;
const WEBCAM_PREVIEW_MAX_HEIGHT: u32 = 360;
const WEBCAM_PREVIEW_JPEG_QUALITY: u8 = 76;

/// What the phone capture page targets. Anything above it is duplicated frames.
const PHONE_CAPTURE_FPS: u32 = 30;

static WEBCAM_PREVIEW_RUNNING: AtomicBool = AtomicBool::new(false);

#[napi]
pub fn list_webcam_devices() -> Vec<WebcamDeviceInfo> {
  query(ApiBackend::MediaFoundation)
    .map(|devices| {
      devices
        .into_iter()
        .enumerate()
        .map(|(index, device)| WebcamDeviceInfo {
          id: device.index().as_string(),
          label: {
            let human_name = device.human_name();
            if human_name.trim().is_empty() {
              format!("Camera {}", index + 1)
            } else {
              human_name
            }
          },
          is_default: index == 0,
        })
        .collect::<Vec<_>>()
    })
    .unwrap_or_default()
}



fn select_camera_index(requested_device_id: Option<&str>) -> Result<CameraIndex, String> {
  let devices = query(ApiBackend::MediaFoundation)
    .map_err(|error| format!("failed to enumerate webcam devices: {error}"))?;

  if devices.is_empty() {
    return Err("no webcam devices available".to_string());
  }

  if let Some(device_id) = requested_device_id {
    if let Some(device) = devices
      .iter()
      .find(|device| device.index().as_string() == device_id)
    {
      return Ok(device.index().clone());
    }

    return Err(format!(
      "requested webcam device '{}' was not found",
      device_id
    ));
  }

  Ok(devices[0].index().clone())
}

fn create_camera(index: CameraIndex, target_fps: u32) -> Result<LocalCamera, String> {
  let request_high_fps =
    RequestedFormat::new::<RgbFormat>(RequestedFormatType::HighestFrameRate(target_fps));
  let request_default = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);

  let open = |request| {
    let mut camera = Camera::with_backend(index.clone(), request, ApiBackend::MediaFoundation)?;
    // Keep the selected capability's rate. Nokhwa's Windows 0.4.5 backend
    // truncates MF_MT_FRAME_RATE's packed ratio to its denominator when reading
    // camera_format(), reporting 1 for a 30/1 camera and throttling us to 1fps.
    let selected = camera.set_camera_requset(request)?;
    Ok::<_, nokhwa::NokhwaError>(LocalCamera {
      camera,
      selected_fps: selected.frame_rate(),
    })
  };
  open(request_high_fps)
    .or_else(|_| open(request_default))
    .map_err(|error| format!("failed to initialize webcam: {error}"))
}

fn preview_jpeg_from_bgra_bottom_up(
  bgra: &[u8],
  width: usize,
  height: usize,
) -> Result<(Vec<u8>, u32, u32), String> {
  let expected_len = width
    .checked_mul(height)
    .and_then(|pixels| pixels.checked_mul(4))
    .ok_or_else(|| "webcam preview dimensions overflowed".to_string())?;
  if width == 0 || height == 0 || bgra.len() < expected_len {
    return Err(format!(
      "webcam preview frame is invalid ({}x{}, have={}, need={})",
      width,
      height,
      bgra.len(),
      expected_len
    ));
  }

  // The encoder wants bottom-up BGRA; image/JPEG wants top-down RGB. Convert
  // while undoing the row flip, so the preview shows the same frame upright.
  let mut rgb = Vec::with_capacity(width * height * 3);
  let bgra_row_bytes = width * 4;
  for target_y in 0..height {
    let source_y = height - 1 - target_y;
    let row = &bgra[source_y * bgra_row_bytes..(source_y + 1) * bgra_row_bytes];
    for pixel in row.chunks_exact(4) {
      rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
    }
  }

  let source = RgbImage::from_raw(width as u32, height as u32, rgb)
    .ok_or_else(|| "failed to construct webcam preview image".to_string())?;
  let preview =
    if source.width() > WEBCAM_PREVIEW_MAX_WIDTH || source.height() > WEBCAM_PREVIEW_MAX_HEIGHT {
      DynamicImage::ImageRgb8(source)
        .resize(
          WEBCAM_PREVIEW_MAX_WIDTH,
          WEBCAM_PREVIEW_MAX_HEIGHT,
          FilterType::Triangle,
        )
        .to_rgb8()
    } else {
      source
    };
  let preview_width = preview.width();
  let preview_height = preview.height();
  let mut jpeg = Vec::new();
  JpegEncoder::new_with_quality(&mut jpeg, WEBCAM_PREVIEW_JPEG_QUALITY)
    .encode(
      preview.as_raw(),
      preview_width,
      preview_height,
      ExtendedColorType::Rgb8,
    )
    .map_err(|error| format!("failed to encode webcam preview: {error}"))?;

  Ok((jpeg, preview_width, preview_height))
}

fn publish_webcam_preview(bgra: &[u8], width: usize, height: usize) -> Result<(), String> {
  let (jpeg, preview_width, preview_height) =
    preview_jpeg_from_bgra_bottom_up(bgra, width, height)?;
  let sequence = WEBCAM_PREVIEW_SEQUENCE
    .fetch_add(1, Ordering::Relaxed)
    .wrapping_add(1);
  let mut slot = preview_frame_slot()
    .lock()
    .map_err(|_| "webcam preview frame lock was poisoned".to_string())?;
  *slot = Some(StoredWebcamPreviewFrame {
    jpeg,
    width: preview_width,
    height: preview_height,
    sequence,
  });
  Ok(())
}

struct PreviewPublisher {
  last_published: Option<Instant>,
}

impl PreviewPublisher {
  fn new() -> Self {
    Self {
      last_published: None,
    }
  }

  fn publish_if_due(&mut self, bgra: &[u8], width: usize, height: usize) {
    if self
      .last_published
      .is_some_and(|last| last.elapsed() < WEBCAM_PREVIEW_PERIOD)
    {
      return;
    }

    if publish_webcam_preview(bgra, width, height).is_ok() {
      self.last_published = Some(Instant::now());
    }
  }
}

/// Where the sidecar loop gets its pictures.
///
/// The loop does not care whether a frame came off a USB camera or over wifi:
/// it asks for the newest one, holds the last if there is none, and writes at
/// its own cadence regardless. Putting a trait across that seam is what lets a
/// phone be a camera without a second recording path -- and it is why the phone
/// inherits the screen recording's clock instead of having to be aligned to it
/// after the fact.
trait FrameSource {
  /// The newest frame, as bottom-up BGRA with its dimensions.
  ///
  /// `Err` means "nothing right now", not "broken". The loop holds the last
  /// frame and carries on, which is what it already did for a USB camera that
  /// missed a read.
  fn next_bgra(&mut self) -> Result<(Vec<u8>, usize, usize), String>;

  /// The rate to write the sidecar at, given what the caller asked for.
  fn effective_fps(&self, requested: u32) -> u32;

  /// Release the device, if there is one. Called on every exit path.
  fn close(&mut self) {}
}

struct LocalCamera {
  camera: Camera,
  selected_fps: u32,
}

impl FrameSource for LocalCamera {
  fn next_bgra(&mut self) -> Result<(Vec<u8>, usize, usize), String> {
    capture_next_bgra_frame(&mut self.camera)
  }

  fn effective_fps(&self, requested: u32) -> u32 {
    let reported = self.selected_fps;
    if reported > 0 {
      reported
    } else {
      requested
    }
  }

  fn close(&mut self) {
    let _ = self.camera.stop_stream();
  }
}

/// The phone, reading whatever the network last delivered.
struct PhoneCamera;

impl FrameSource for PhoneCamera {
  fn next_bgra(&mut self) -> Result<(Vec<u8>, usize, usize), String> {
    phone_camera::take_frame().ok_or_else(|| {
      if phone_camera::is_live() {
        // Between frames. Expected thirty times a second and not worth saying
        // anything about.
        "no new frame yet".to_string()
      } else {
        "the phone has stopped sending frames".to_string()
      }
    })
  }

  /// Capped at what the page actually sends.
  ///
  /// A network camera has no format to interrogate, so this used to take the
  /// requested rate at face value -- which for the editor's default of 60 meant
  /// encoding sixty 720p frames a second when the phone sends thirty. Half of
  /// them were re-encodes of a frame already written, and on a machine also
  /// capturing a screen that is enough extra work to push the loop off its
  /// cadence, which is exactly the condition `advance_stamp` exists to survive.
  /// Better not to create it.
  fn effective_fps(&self, requested: u32) -> u32 {
    requested.min(PHONE_CAPTURE_FPS)
  }
}


fn capture_next_bgra_frame(camera: &mut Camera) -> Result<(Vec<u8>, usize, usize), String> {
  let frame = camera
    .frame()
    .map_err(|error| format!("capture failed: {error}"))?;

  let rgb_frame = frame
    .decode_image::<RgbFormat>()
    .map_err(|error| format!("decode failed: {error}"))?;

  let frame_width = rgb_frame.width() as usize;
  let frame_height = rgb_frame.height() as usize;

  let rgb_raw = rgb_frame.into_raw();
  let expected_len = frame_width.saturating_mul(frame_height).saturating_mul(3);
  if rgb_raw.len() < expected_len {
    return Err(format!(
      "decoded frame buffer too small (have={}, need={})",
      rgb_raw.len(),
      expected_len
    ));
  }

  Ok((
    rgb_to_bgra_bottom_up(&rgb_raw, frame_width, frame_height),
    frame_width,
    frame_height,
  ))
}


// WGC SystemRelativeTime uses this same QPC domain, expressed in 100ns units.
fn qpc_100ns() -> windows::core::Result<i64> {
  use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
  let mut counter = 0;
  let mut frequency = 0;
  unsafe {
    QueryPerformanceFrequency(&mut frequency)?;
    QueryPerformanceCounter(&mut counter)?;
  }
  Ok(((counter as i128 * 10_000_000) / frequency as i128) as i64)
}

/// Feed the transcoder a complete constant-rate timeline. Sparse samples let
/// it backfill a gap with the *next* image, displaying speech before it happened.
struct WebcamTimeline {
  fps: u32,
  next_frame: u64,
  previous: Vec<u8>,
}

impl WebcamTimeline {
  fn new(fps: u32, frame_bytes: usize) -> Self {
    Self {
      fps: fps.max(1),
      next_frame: 0,
      previous: vec![0; frame_bytes],
    }
  }

  fn write_frame(
    &mut self,
    encoder: &mut VideoEncoder,
    frame: &[u8],
    received_100ns: i64,
  ) -> Result<(), windows_capture::encoder::VideoEncoderError> {
    // Round upward: a picture must not appear before it was received.
    let target =
      ((received_100ns.max(0) as u128 * self.fps as u128 + 9_999_999) / 10_000_000) as u64;
    while self.next_frame <= target {
      let timestamp = (self.next_frame as u128 * 10_000_000 / self.fps as u128) as i64;
      let pixels = if self.next_frame == target {
        frame
      } else {
        &self.previous
      };
      encoder.send_frame_buffer(pixels, timestamp)?;
      self.next_frame += 1;
    }
    self.previous.clear();
    self.previous.extend_from_slice(frame);
    Ok(())
  }
}


/// Open the camera a source names, ready to deliver frames.
///
/// Called on the recording thread rather than handed one, because `nokhwa`'s
/// `Camera` is not `Send` -- the device has to be opened where it will be read.
fn open_source(source: WebcamSource, requested_fps: u32) -> Result<Box<dyn FrameSource>, String> {
  match source {
    WebcamSource::Phone => {
      // Nothing to open. The phone is already connected and pushing by the time
      // a recording starts -- the user paired it and watched the preview -- so
      // the only thing that could be wrong here is that it went away since, and
      // the startup window below is what catches that.
      Ok(Box::new(PhoneCamera))
    }
    WebcamSource::Local(device_id) => {
      let index = select_camera_index(device_id.as_deref())?;
      let mut camera = create_camera(index, requested_fps)?;
      camera
        .camera
        .open_stream()
        .map_err(|error| format!("failed to open webcam stream: {error}"))?;
      Ok(Box::new(camera))
    }
  }
}

struct PreviewRunningGuard;

impl Drop for PreviewRunningGuard {
  fn drop(&mut self) {
    WEBCAM_PREVIEW_RUNNING.store(false, Ordering::Release);
  }
}

struct CameraThreadComGuard;

impl CameraThreadComGuard {
  fn initialize() -> Result<Self, String> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }
      .ok()
      .map_err(|error| format!("failed to initialize camera worker COM apartment: {error}"))?;
    Ok(Self)
  }
}

impl Drop for CameraThreadComGuard {
  fn drop(&mut self) {
    unsafe { CoUninitialize() };
  }
}

fn run_webcam_preview_loop(
  device_id: Option<String>,
  stop_rx: Receiver<()>,
  ready_tx: Sender<Result<(), String>>,
) {
  let _running_guard = PreviewRunningGuard;
  let _com_guard = match CameraThreadComGuard::initialize() {
    Ok(guard) => guard,
    Err(error) => {
      let _ = ready_tx.send(Err(error));
      return;
    }
  };
  let mut camera = match open_source(WebcamSource::Local(device_id), WEBCAM_PREVIEW_FPS) {
    Ok(source) => source,
    Err(error) => {
      let _ = ready_tx.send(Err(error));
      return;
    }
  };

  let effective_fps = camera.effective_fps(WEBCAM_PREVIEW_FPS).max(1);
  let frame_period = Duration::from_nanos(1_000_000_000u64 / effective_fps as u64);
  let startup_deadline = Instant::now() + WEBCAM_READY_FRAME_TIMEOUT;
  let mut ready_tx = Some(ready_tx);
  let mut startup_error = "no frame produced".to_string();
  let mut preview = PreviewPublisher::new();

  loop {
    match stop_rx.try_recv() {
      Ok(_) | Err(TryRecvError::Disconnected) => break,
      Err(TryRecvError::Empty) => {}
    }

    let frame_started = Instant::now();
    match camera.next_bgra() {
      Ok((frame, width, height)) => {
        if ready_tx.is_some() {
          match publish_webcam_preview(&frame, width, height) {
            Ok(()) => {
              preview.last_published = Some(Instant::now());
              if let Some(sender) = ready_tx.take() {
                let _ = sender.send(Ok(()));
              }
            }
            Err(error) => startup_error = error,
          }
        } else {
          preview.publish_if_due(&frame, width, height);
        }
      }
      Err(error) => startup_error = error,
    }

    if ready_tx.is_some() && Instant::now() >= startup_deadline {
      if let Some(sender) = ready_tx.take() {
        let _ = sender.send(Err(format!(
          "webcam preview produced no valid frame in startup window: {startup_error}"
        )));
      }
      break;
    }

    let elapsed = frame_started.elapsed();
    if elapsed < frame_period {
      thread::sleep(frame_period - elapsed);
    }
  }

  camera.close();
}

/**
 * Open one local webcam for the recorder setup preview.
 *
 * The returned stopper must be stopped before recording begins. The recording
 * loop then publishes into the same preview slot while it owns the device, so
 * there is never a browser/native or preview/recording ownership race.
 */
#[napi]
pub fn start_webcam_preview(device_id: Option<String>) -> napi::Result<Stopper> {
  if WEBCAM_PREVIEW_RUNNING
    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
    .is_err()
  {
    return Err(napi::Error::from_reason(
      "a native webcam preview is already running".to_string(),
    ));
  }

  clear_webcam_preview_frame();
  let (stop_tx, stop_rx) = channel();
  let (done_tx, done_rx) = channel();
  let (ready_tx, ready_rx) = channel();

  thread::spawn(move || {
    run_webcam_preview_loop(device_id, stop_rx, ready_tx);
    let _ = done_tx.send(());
  });

  match ready_rx.recv_timeout(Duration::from_secs(8)) {
    Ok(Ok(())) => Ok(Stopper::from_channels(stop_tx, done_rx)),
    Ok(Err(error)) => {
      let _ = stop_tx.send(());
      let _ = done_rx.recv_timeout(Duration::from_secs(2));
      Err(napi::Error::from_reason(format!(
        "failed to start native webcam preview: {error}"
      )))
    }
    Err(RecvTimeoutError::Timeout) => {
      let _ = stop_tx.send(());
      let _ = done_rx.recv_timeout(Duration::from_secs(2));
      Err(napi::Error::from_reason(
        "native webcam preview startup timed out".to_string(),
      ))
    }
    Err(RecvTimeoutError::Disconnected) => Err(napi::Error::from_reason(
      "native webcam preview thread exited during startup".to_string(),
    )),
  }
}

fn run_webcam_recording_loop(
  output_path: String,
  source: WebcamSource,
  target_fps: Option<u32>,
  stop_rx: Receiver<()>,
  ready_tx: Sender<Result<(), String>>,
  screen_stats: Arc<RecordingStats>,
) {
  let sidecar_path = camera_sidecar_path(&output_path);
  let requested_fps = target_webcam_fps(target_fps);

  let _com_guard = match CameraThreadComGuard::initialize() {
    Ok(guard) => guard,
    Err(error) => {
      let _ = ready_tx.send(Err(error));
      return;
    }
  };

  let mut camera = match open_source(source, requested_fps) {
    Ok(source) => source,
    Err(error) => {
      let _ = ready_tx.send(Err(error));
      return;
    }
  };

  let effective_fps = camera.effective_fps(requested_fps);
  let frame_period_nanos = (1_000_000_000u64 / effective_fps.max(1) as u64).max(1);
  let frame_period_duration = Duration::from_nanos(frame_period_nanos);

  // Do not report startup success until we can actually deliver a webcam frame.
  let startup_deadline = Instant::now() + WEBCAM_READY_FRAME_TIMEOUT;
  let mut latest_bgra: Option<Vec<u8>> = None;
  let mut expected_frame_width: usize = 0;
  let mut expected_frame_height: usize = 0;
  let mut first_received_100ns = 0;
  let mut startup_error = String::from("no frame produced");
  let mut preview = PreviewPublisher::new();

  while Instant::now() < startup_deadline {
    match stop_rx.try_recv() {
      Ok(_) | Err(TryRecvError::Disconnected) => {
        camera.close();
        return;
      }
      Err(TryRecvError::Empty) => {}
    }

    match camera.next_bgra() {
      Ok((frame, frame_width, frame_height)) => {
        first_received_100ns = match qpc_100ns() {
          Ok(time) => time,
          Err(error) => {
            camera.close();
            let _ = ready_tx.send(Err(error.to_string()));
            return;
          }
        };
        preview.publish_if_due(&frame, frame_width, frame_height);
        latest_bgra = Some(frame);
        expected_frame_width = frame_width;
        expected_frame_height = frame_height;
        break;
      }
      Err(error) => {
        startup_error = error;
        thread::sleep(Duration::from_millis(12));
      }
    }
  }

  if latest_bgra.is_none() {
    camera.close();
    let _ = ready_tx.send(Err(format!(
      "webcam stream produced no valid frame in startup window: {}",
      startup_error
    )));
    return;
  }

  // The screen encoder subtracts the first WGC frame's QPC timestamp.
  // Wait for that exact origin instead of creating a second time zero.
  let screen_origin = loop {
    if let Some(origin) = screen_stats.first_timestamp_100ns() {
      break origin;
    }
    if Instant::now() >= startup_deadline || stop_rx.try_recv() != Err(TryRecvError::Empty) {
      camera.close();
      let _ = ready_tx.send(Err("screen capture did not establish a clock".to_string()));
      return;
    }
    thread::sleep(Duration::from_millis(2));
  };

  let mut encoder = match VideoEncoder::new(
    VideoSettingsBuilder::new(expected_frame_width as u32, expected_frame_height as u32)
      .frame_rate(effective_fps)
      .bitrate(WEBCAM_DEFAULT_BITRATE)
      // windows-capture defaults to HEVC, and a stock Windows install has no
      // HEVC decoder MFT -- the sidecar would be undecodable by the engine even
      // though the screen track next to it is fine.
      .sub_type(VideoSettingsSubType::H264),
    AudioSettingsBuilder::default().disabled(true),
    ContainerSettingsBuilder::default(),
    &sidecar_path,
  ) {
    Ok(encoder) => encoder,
    Err(error) => {
      camera.close();
      let _ = ready_tx.send(Err(format!("failed to initialize webcam encoder: {error}")));
      return;
    }
  };

  let mut timeline = WebcamTimeline::new(
    effective_fps,
    expected_frame_width * expected_frame_height * 4,
  );
  if let Some(first_frame) = latest_bgra.as_ref() {
    let timestamp = webcam_stamp(screen_origin, first_received_100ns, 0);
    if let Err(error) = timeline.write_frame(&mut encoder, first_frame, timestamp) {
      camera.close();
      let _ = encoder.finish();
      let _ = ready_tx.send(Err(format!(
        "failed to encode first webcam frame: {}",
        error
      )));
      return;
    }
  }

  let _ = ready_tx.send(Ok(()));

  // Stamp each completed read against the same origin, before encoding it.
  let mut mismatched_dimension_counter: u64 = 0;
  let mut starved: u64 = 0;

  loop {
    match stop_rx.try_recv() {
      Ok(_) | Err(TryRecvError::Disconnected) => break,
      Err(TryRecvError::Empty) => {}
    }

    let frame_start = Instant::now();

    let next_frame = camera.next_bgra();
    let received_100ns = match qpc_100ns() {
      Ok(time) => time,
      Err(error) => {
        eprintln!("[VelocityCapture] Webcam clock failed: {error}");
        break;
      }
    };
    match next_frame {
      Ok((frame, frame_width, frame_height)) => {
        if frame_width == expected_frame_width && frame_height == expected_frame_height {
          preview.publish_if_due(&frame, frame_width, frame_height);
          latest_bgra = Some(frame);
        } else {
          mismatched_dimension_counter = mismatched_dimension_counter.saturating_add(1);
          if mismatched_dimension_counter <= 3 || mismatched_dimension_counter.is_multiple_of(60) {
            eprintln!(
              "[VelocityCapture] Webcam frame resolution changed unexpectedly (got={}x{}, expected={}x{}); reusing last frame.",
              frame_width,
              frame_height,
              expected_frame_width,
              expected_frame_height,
            );
          }
        }
      }
      Err(error) => {
        // Hold-last-frame interpolation: keep timeline smooth when capture drops
        // intermittently. Not logged every time -- a network camera is between
        // frames far more often than it is delivering one, and saying so thirty
        // times a second would bury everything else in the log.
        starved = starved.saturating_add(1);
        if starved == 1 || starved.is_multiple_of(300) {
          eprintln!(
            "[VelocityCapture] Webcam frame unavailable ({starved} so far); reusing last frame: {error}"
          );
        }
      }
    }

    let timestamp = webcam_stamp(screen_origin, received_100ns, 0);
    if let Some(frame) = latest_bgra.as_ref() {
      if let Err(error) = timeline.write_frame(&mut encoder, frame, timestamp) {
        eprintln!("[VelocityCapture] Failed to encode webcam frame: {error}");
      }
    } else {
      eprintln!("[VelocityCapture] Webcam frame unavailable and no fallback frame cached.");
      thread::sleep(Duration::from_millis(6));
      continue;
    }

    let elapsed = frame_start.elapsed();
    if elapsed < frame_period_duration {
      thread::sleep(frame_period_duration - elapsed);
    }
  }

  camera.close();
  let _ = encoder.finish();
}

pub(crate) fn start_webcam_sidecar_recording(
  output_path: &str,
  source: WebcamSource,
  target_fps: Option<u32>,
  screen_stats: Arc<RecordingStats>,
) -> napi::Result<Stopper> {
  let (stop_tx, stop_rx) = channel();
  let (done_tx, done_rx) = channel();
  let (ready_tx, ready_rx) = channel();
  let output_path = output_path.to_string();

  thread::spawn(move || {
    run_webcam_recording_loop(
      output_path,
      source,
      target_fps,
      stop_rx,
      ready_tx,
      screen_stats,
    );
    let _ = done_tx.send(());
  });

  match ready_rx.recv_timeout(Duration::from_secs(8)) {
    Ok(Ok(())) => Ok(Stopper::from_channels(stop_tx, done_rx)),
    Ok(Err(error)) => Err(napi::Error::from_reason(format!(
      "failed to start native webcam recording: {}",
      error
    ))),
    Err(RecvTimeoutError::Timeout) => Err(napi::Error::from_reason(
      "native webcam recording startup timed out".to_string(),
    )),
    Err(RecvTimeoutError::Disconnected) => Err(napi::Error::from_reason(
      "native webcam recording thread exited during startup".to_string(),
    )),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// One frame period, in 100ns units, at 60fps.
  const PERIOD_60: i64 = 166_667;

  #[test]
  fn stamps_advance_by_one_period_when_the_loop_keeps_up() {
    // Elapsed time matches where the counter already is, so nothing is forced.
    assert_eq!(advance_stamp(0, PERIOD_60, 0), PERIOD_60);
    assert_eq!(
      advance_stamp(PERIOD_60, PERIOD_60, PERIOD_60),
      PERIOD_60 * 2
    );
  }

  #[test]
  fn stamps_catch_up_to_the_clock_when_the_encoder_falls_behind() {
    // Half a second of wall time has passed but the counter only got three
    // frames in. Advancing by a period would label those three as 50ms of
    // video, and the camera track would run half a second early by this point.
    let caught_up = advance_stamp(PERIOD_60 * 3, PERIOD_60, 5_000_000);
    assert_eq!(caught_up, 5_000_000);
  }

  #[test]
  fn stamps_never_go_backwards() {
    // A clock reading behind the counter -- a frame written early, or a lagging
    // Instant -- must not rewind the track.
    let stamp = advance_stamp(PERIOD_60 * 10, PERIOD_60, 0);
    assert_eq!(stamp, PERIOD_60 * 11);
    assert!(stamp > PERIOD_60 * 10);
  }

  #[test]
  fn a_phone_is_not_asked_for_more_than_it_sends() {
    // The editor defaults to 60; the capture page sends 30. The difference was
    // sixty per cent of the encoder's work spent re-encoding frames it had
    // already written.
    assert_eq!(PhoneCamera.effective_fps(60), PHONE_CAPTURE_FPS);
    assert_eq!(PhoneCamera.effective_fps(30), 30);
    // And a caller asking for less than the page sends still gets what it asked
    // for, rather than being raised to the cap.
    assert_eq!(PhoneCamera.effective_fps(15), 15);
  }

  #[test]
  fn camera_sidecar_path_inserts_camera_suffix_before_extension() {
    assert_eq!(camera_sidecar_path("recording.mp4"), "recording_camera.mp4");
  }

  #[test]
  fn camera_sidecar_path_preserves_directory_and_extension() {
    let sidecar = camera_sidecar_path("tests/recording_123.mkv");
    let expected = Path::new("tests").join("recording_123_camera.mkv");
    assert_eq!(Path::new(&sidecar), expected.as_path());
  }

  #[test]
  fn camera_sidecar_path_defaults_extension_to_mp4_when_missing() {
    let sidecar = camera_sidecar_path("tests/recording_noext");
    assert_eq!(
      Path::new(&sidecar)
        .extension()
        .and_then(|value| value.to_str()),
      Some("mp4")
    );
    assert!(sidecar.contains("recording_noext_camera"));
  }

  #[test]
  fn camera_sidecar_path_handles_bare_filename_without_directory() {
    assert_eq!(camera_sidecar_path("output.mov"), "output_camera.mov");
  }

  #[test]
  fn camera_sidecar_path_falls_back_to_recording_stem_when_path_has_no_file_name() {
    // `Path::file_stem` returns None for inputs like "." or "..", exercising the fallback.
    let sidecar = camera_sidecar_path(".");
    assert!(sidecar.contains("recording_camera"));
  }

  #[test]
  fn target_webcam_fps_defaults_to_60_when_none() {
    assert_eq!(target_webcam_fps(None), 60);
  }

  #[test]
  fn target_webcam_fps_accepts_30_and_60() {
    assert_eq!(target_webcam_fps(Some(30)), 30);
    assert_eq!(target_webcam_fps(Some(60)), 60);
  }

  #[test]
  fn target_webcam_fps_falls_back_to_60_for_unsupported_values() {
    assert_eq!(target_webcam_fps(Some(24)), 60);
    assert_eq!(target_webcam_fps(Some(120)), 60);
    assert_eq!(target_webcam_fps(Some(0)), 60);
  }



}




#[cfg(test)]
mod colour_conversion_scenarios {
  use super::*;

  #[test]
  fn the_output_is_four_bytes_a_pixel() {
    for (w, h) in [(1usize, 1usize), (4, 4), (16, 9), (320, 240)] {
      let rgb = vec![0u8; w * h * 3];
      assert_eq!(
        rgb_to_bgra_bottom_up(&rgb, w, h).len(),
        w * h * 4,
        "{w}x{h}"
      );
    }
  }

  #[test]
  fn the_channel_order_is_reversed() {
    let rgb = vec![10, 20, 30];
    let bgra = rgb_to_bgra_bottom_up(&rgb, 1, 1);
    assert_eq!(bgra[0], 30);
    assert_eq!(bgra[1], 20);
    assert_eq!(bgra[2], 10);
  }

  #[test]
  fn every_pixel_comes_out_fully_opaque() {
    let rgb: Vec<u8> = (0..(4 * 4 * 3)).map(|i| i as u8).collect();
    let bgra = rgb_to_bgra_bottom_up(&rgb, 4, 4);
    for i in (3..bgra.len()).step_by(4) {
      assert_eq!(bgra[i], 255, "byte {i}");
    }
  }

  #[test]
  fn the_rows_come_out_upside_down() {
    // The encoder wants bottom-up BGRA; the camera hands over top-down RGB.
    let rgb = vec![
      1, 1, 1, // row 0
      2, 2, 2, // row 1
      3, 3, 3, // row 2
    ];
    let bgra = rgb_to_bgra_bottom_up(&rgb, 1, 3);
    assert_eq!(bgra[0], 3);
    assert_eq!(bgra[4], 2);
    assert_eq!(bgra[8], 1);
  }

  #[test]
  fn a_single_row_is_its_own_flip() {
    let rgb = vec![1, 2, 3, 4, 5, 6];
    let bgra = rgb_to_bgra_bottom_up(&rgb, 2, 1);
    assert_eq!(&bgra[..4], &[3, 2, 1, 255]);
    assert_eq!(&bgra[4..], &[6, 5, 4, 255]);
  }

  #[test]
  fn pixels_within_a_row_keep_their_order() {
    // Only the rows flip; flipping within a row too would mirror the picture.
    let rgb = vec![1, 0, 0, 2, 0, 0, 3, 0, 0];
    let bgra = rgb_to_bgra_bottom_up(&rgb, 3, 1);
    assert_eq!([bgra[2], bgra[6], bgra[10]], [1, 2, 3]);
  }

  #[test]
  fn flipping_twice_would_return_the_original_row_order() {
    let rgb: Vec<u8> = (0..(2 * 5 * 3)).map(|i| i as u8).collect();
    let bgra = rgb_to_bgra_bottom_up(&rgb, 2, 5);
    // Row 0 of the source is the last row of the output.
    let last_row = &bgra[4 * 2 * 4..];
    assert_eq!(last_row[2], rgb[0]);
    assert_eq!(last_row[1], rgb[1]);
    assert_eq!(last_row[0], rgb[2]);
  }

  #[test]
  fn a_short_buffer_leaves_the_missing_rows_black() {
    // `chunks_exact` stops early rather than reading past the end.
    let rgb = vec![9u8; 3]; // one row of a two row image
    let bgra = rgb_to_bgra_bottom_up(&rgb, 1, 2);
    assert_eq!(bgra.len(), 8);
    // The one row present lands at the bottom; the other stays zeroed.
    assert_eq!(&bgra[4..], &[9, 9, 9, 255]);
    assert_eq!(&bgra[..4], &[0, 0, 0, 0]);
  }

  #[test]
  fn a_trailing_partial_row_is_ignored() {
    let rgb = vec![1u8; 3 + 2]; // one full row plus two stray bytes
    let bgra = rgb_to_bgra_bottom_up(&rgb, 1, 2);
    assert_eq!(bgra.len(), 8);
  }

  #[test]
  fn full_scale_values_survive_the_conversion() {
    let rgb = vec![255, 0, 128];
    let bgra = rgb_to_bgra_bottom_up(&rgb, 1, 1);
    assert_eq!(&bgra[..], &[128, 0, 255, 255]);
  }

  #[test]
  fn a_realistic_frame_converts_without_losing_a_byte() {
    let (w, h) = (320usize, 240usize);
    let rgb: Vec<u8> = (0..(w * h * 3)).map(|i| (i % 251) as u8).collect();
    let bgra = rgb_to_bgra_bottom_up(&rgb, w, h);
    assert_eq!(bgra.len(), w * h * 4);
    // Every source byte should appear somewhere; spot-check the first pixel of
    // the first source row, which lands in the last output row.
    let last_row = (h - 1) * w * 4;
    assert_eq!(bgra[last_row + 2], rgb[0]);
  }
}

#[cfg(test)]
mod preview_frame_scenarios {
  use super::*;

  #[test]
  fn the_native_preview_is_a_decodable_jpeg() {
    let rgb = vec![96u8; 64 * 48 * 3];
    let bgra = rgb_to_bgra_bottom_up(&rgb, 64, 48);
    let (jpeg, width, height) =
      preview_jpeg_from_bgra_bottom_up(&bgra, 64, 48).expect("preview jpeg");

    let decoded = image::load_from_memory(&jpeg).expect("decodable jpeg");
    assert_eq!(decoded.width(), width);
    assert_eq!(decoded.height(), height);
  }

  #[test]
  fn the_native_preview_is_bounded_without_changing_aspect_ratio() {
    let rgb = vec![0u8; 960 * 540 * 3];
    let bgra = rgb_to_bgra_bottom_up(&rgb, 960, 540);
    let (_, width, height) =
      preview_jpeg_from_bgra_bottom_up(&bgra, 960, 540).expect("preview jpeg");

    assert_eq!((width, height), (480, 270));
  }

  #[test]
  fn the_native_preview_undoes_the_encoder_row_flip() {
    let (width, height) = (32usize, 16usize);
    let mut rgb = Vec::with_capacity(width * height * 3);
    for y in 0..height {
      let colour = if y < height / 2 {
        [240, 16, 16]
      } else {
        [16, 16, 240]
      };
      for _ in 0..width {
        rgb.extend_from_slice(&colour);
      }
    }

    let bgra = rgb_to_bgra_bottom_up(&rgb, width, height);
    let (jpeg, _, _) =
      preview_jpeg_from_bgra_bottom_up(&bgra, width, height).expect("preview jpeg");
    let decoded = image::load_from_memory(&jpeg)
      .expect("decodable jpeg")
      .to_rgb8();
    let top = decoded.get_pixel(width as u32 / 2, 2).0;
    let bottom = decoded.get_pixel(width as u32 / 2, height as u32 - 3).0;

    assert!(top[0] > top[2], "top pixel should remain red: {top:?}");
    assert!(
      bottom[2] > bottom[0],
      "bottom pixel should remain blue: {bottom:?}"
    );
  }

  #[test]
  fn an_empty_native_preview_frame_is_rejected() {
    assert!(preview_jpeg_from_bgra_bottom_up(&[], 0, 0).is_err());
  }
}

#[cfg(test)]
mod shared_capture_timeline_tests {
  use super::*;

  #[test]
  fn camera_startup_is_preserved_instead_of_becoming_time_zero() {
    assert_eq!(webcam_stamp(100_000_000, 107_500_000, 0), 7_500_000);
  }

  #[test]
  fn a_slow_camera_read_is_stamped_after_it_completes() {
    let origin = 100_000_000;
    let first = webcam_stamp(origin, origin + 5_000_000, 0);
    let after_stall = webcam_stamp(origin, origin + 8_000_000, first);
    assert_eq!(after_stall, 8_000_000);
  }

  #[test]
  fn repeated_clock_values_never_rewind_or_add_a_frame_period() {
    assert_eq!(webcam_stamp(100, 110, 10), 11);
    assert_eq!(webcam_stamp(100, 99, 0), 1);
  }

  #[test]
  #[ignore = "requires Windows GPU and Media Foundation encoder"]
  fn encoded_camera_keeps_its_startup_gap() -> Result<(), Box<dyn std::error::Error>> {
    let _com = CameraThreadComGuard::initialize()?;
    let path = std::env::var("RECSO_WEBCAM_TIMING_PROBE")?;
    let mut encoder = VideoEncoder::new(
      VideoSettingsBuilder::new(64, 64).sub_type(VideoSettingsSubType::H264),
      AudioSettingsBuilder::default().disabled(true),
      ContainerSettingsBuilder::default(),
      &path,
    )?;
    let red: Vec<u8> = [0, 0, 255, 255].repeat(64 * 64);
    let green: Vec<u8> = [0, 255, 0, 255].repeat(64 * 64);
    let origin = 100_000_000;
    let first = webcam_stamp(origin, origin + 5_000_000, 0);
    let mut timeline = WebcamTimeline::new(60, red.len());
    timeline.write_frame(&mut encoder, &red, first)?;
    // No camera frame arrives between 500ms and 1s: hold red through the stall.
    for tick in 10..=15 {
      timeline.write_frame(
        &mut encoder,
        &green,
        webcam_stamp(origin, origin + tick * 1_000_000, 0),
      )?;
    }
    encoder.finish()?;

    // Verify the actual file through an independent decoder; the encoder
    // normalizes timestamps internally, so arithmetic-only tests miss this.
    let decoded = std::process::Command::new("ffmpeg")
      .args([
        "-v", "error", "-i", &path, "-vf", "fps=60", "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
      ])
      .output()?;
    assert!(
      decoded.status.success(),
      "{}",
      String::from_utf8_lossy(&decoded.stderr)
    );
    let frames: Vec<&[u8]> = decoded.stdout.chunks_exact(64 * 64 * 3).collect();
    let first_red = frames
      .iter()
      .position(|frame| frame[(32 * 64 + 32) * 3] > 150)
      .expect("camera marker was never encoded");
    assert!(
      (29..=31).contains(&first_red),
      "camera marker appeared at frame {first_red}, expected 500ms / frame 30"
    );
    let first_green = frames
      .iter()
      .position(|frame| frame[(32 * 64 + 32) * 3 + 1] > 150)
      .expect("second camera marker was never encoded");
    assert!(
      (59..=61).contains(&first_green),
      "future image filled the capture stall: frame {first_green}, expected 1s / frame 60"
    );
    Ok(())
  }
}
