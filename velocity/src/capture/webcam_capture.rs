use super::desktop_capture::Stopper;
use super::phone_camera;
use crate::singular_clock::fps_to_period_100ns;
use napi_derive::napi;
use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{ApiBackend, CameraIndex, RequestedFormat, RequestedFormatType};
use nokhwa::{query, Camera};
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};
use windows_capture::encoder::{
  AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
  VideoSettingsSubType,
};

const WEBCAM_DEFAULT_BITRATE: u32 = 3_000_000;
const WEBCAM_READY_FRAME_TIMEOUT: Duration = Duration::from_secs(5);

/// What the phone capture page targets. Anything above it is duplicated frames.
const PHONE_CAPTURE_FPS: u32 = 30;

#[napi(object)]
pub struct WebcamDeviceInfo {
  pub id: String,
  pub label: String,
  pub is_default: bool,
}

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

fn camera_sidecar_path(output_path: &str) -> String {
  let source = Path::new(output_path);
  let parent = source.parent().unwrap_or_else(|| Path::new(""));
  let stem = source
    .file_stem()
    .and_then(|value| value.to_str())
    .unwrap_or("recording");
  let ext = source
    .extension()
    .and_then(|value| value.to_str())
    .filter(|value| !value.is_empty())
    .unwrap_or("mp4");

  parent
    .join(format!("{}_camera.{}", stem, ext))
    .to_string_lossy()
    .to_string()
}

fn target_webcam_fps(target_fps: Option<u32>) -> u32 {
  match target_fps {
    Some(30) => 30,
    Some(60) | None => 60,
    Some(other) => {
      eprintln!(
        "[VelocityCapture] Requested unsupported webcam target_fps={other}. Falling back to 60 fps."
      );
      60
    }
  }
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

fn create_camera(index: CameraIndex, target_fps: u32) -> Result<Camera, String> {
  let request_high_fps = RequestedFormat::new::<RgbFormat>(RequestedFormatType::HighestFrameRate(target_fps));
  let request_default = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);

  Camera::with_backend(index.clone(), request_high_fps, ApiBackend::MediaFoundation)
    .or_else(|_| Camera::with_backend(index, request_default, ApiBackend::MediaFoundation))
    .map_err(|error| format!("failed to initialize webcam: {error}"))
}

pub(crate) fn rgb_to_bgra_bottom_up(rgb: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut output = vec![0u8; width * height * 4];
    let row_bytes_rgb = width * 3;
    let row_bytes_bgra = width * 4;

    // Iterate over rows in reverse to flip the image bottom-up
    for (y, rgb_row) in rgb.chunks_exact(row_bytes_rgb).enumerate() {
        let dst_y = height - 1 - y;
        let dst_row = &mut output[dst_y * row_bytes_bgra .. (dst_y + 1) * row_bytes_bgra];

        // Zip the chunks together to eliminate bounds checking entirely
        for (src_pixel, dst_pixel) in rgb_row.chunks_exact(3).zip(dst_row.chunks_exact_mut(4)) {
            dst_pixel[0] = src_pixel[2]; // B
            dst_pixel[1] = src_pixel[1]; // G
            dst_pixel[2] = src_pixel[0]; // R
            dst_pixel[3] = 255;          // A
        }
    }

    output
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
}

impl FrameSource for LocalCamera {
  fn next_bgra(&mut self) -> Result<(Vec<u8>, usize, usize), String> {
    capture_next_bgra_frame(&mut self.camera)
  }

  fn effective_fps(&self, requested: u32) -> u32 {
    let reported = self.camera.camera_format().frame_rate();
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

/// Which camera a recording is using.
pub(crate) enum WebcamSource {
  /// A camera attached to this machine, by device id or the default.
  Local(Option<String>),
  /// A phone streaming over the local network, already paired and sending.
  Phone,
}

fn capture_next_bgra_frame(
  camera: &mut Camera,
 ) -> Result<(Vec<u8>, usize, usize), String> {
  let frame = camera
    .frame()
    .map_err(|error| format!("capture failed: {error}"))?;

  let rgb_frame = frame
    .decode_image::<RgbFormat>()
    .map_err(|error| format!("decode failed: {error}"))?;

  let frame_width = rgb_frame.width() as usize;
  let frame_height = rgb_frame.height() as usize;

  let rgb_raw = rgb_frame.into_raw();
  let expected_len = frame_width
    .saturating_mul(frame_height)
    .saturating_mul(3);
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

/// The timestamp for the next sidecar frame.
///
/// One frame period on from the last, but never behind the wall clock.
///
/// The period alone is what the loop used to do, and it is right only while the
/// loop actually hits its rate. When it cannot -- a busy machine, a software
/// encoder asked for 60fps of 720p -- the stamps keep advancing as though it
/// did, so N frames written over a longer T seconds get labelled N/fps seconds.
/// The camera track then comes out shorter than the recording and drifts
/// steadily ahead of the picture, which looks like the webcam running early
/// rather than like dropped frames.
///
/// Taking the clock as a floor keeps the original intent -- stamps advance even
/// when a frame fails, so the two tracks end the same length -- and adds the
/// part that was missing: they cannot advance faster than time did.
fn advance_stamp(current_100ns: i64, period_100ns: i64, elapsed_100ns: i64) -> i64 {
  current_100ns
    .saturating_add(period_100ns)
    .max(elapsed_100ns)
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
        .open_stream()
        .map_err(|error| format!("failed to open webcam stream: {error}"))?;
      Ok(Box::new(LocalCamera { camera }))
    }
  }
}

fn run_webcam_recording_loop(
  output_path: String,
  source: WebcamSource,
  target_fps: Option<u32>,
  stop_rx: Receiver<()>,
  ready_tx: Sender<Result<(), String>>,
) {
  let sidecar_path = camera_sidecar_path(&output_path);
  let requested_fps = target_webcam_fps(target_fps);

  let mut camera = match open_source(source, requested_fps) {
    Ok(source) => source,
    Err(error) => {
      let _ = ready_tx.send(Err(error));
      return;
    }
  };

  let effective_fps = camera.effective_fps(requested_fps);
  let frame_period_100ns = fps_to_period_100ns(effective_fps);

  let mut frame_index_100ns: i64 = 0;
  let frame_period_nanos = (1_000_000_000u64 / effective_fps.max(1) as u64).max(1);
  let frame_period_duration = Duration::from_nanos(frame_period_nanos);

  // Do not report startup success until we can actually deliver a webcam frame.
  let startup_deadline = Instant::now() + WEBCAM_READY_FRAME_TIMEOUT;
  let mut latest_bgra: Option<Vec<u8>> = None;
  let mut expected_frame_width: usize = 0;
  let mut expected_frame_height: usize = 0;
  let mut startup_error = String::from("no frame produced");

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

  let mut encoder = match VideoEncoder::new(
    VideoSettingsBuilder::new(expected_frame_width as u32, expected_frame_height as u32)
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

  if let Some(first_frame) = latest_bgra.as_ref() {
    if let Err(error) = encoder.send_frame_buffer(first_frame, frame_index_100ns) {
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

  // Time zero is the first frame handed to the encoder, so every stamp below is
  // measured from the same instant the track starts at.
  let started = Instant::now();
  frame_index_100ns = frame_index_100ns.saturating_add(frame_period_100ns);
  let mut mismatched_dimension_counter: u64 = 0;
  let mut starved: u64 = 0;

  loop {
    match stop_rx.try_recv() {
      Ok(_) | Err(TryRecvError::Disconnected) => break,
      Err(TryRecvError::Empty) => {}
    }

    let frame_start = Instant::now();

    match camera.next_bgra() {
      Ok((frame, frame_width, frame_height)) => {
        if frame_width == expected_frame_width && frame_height == expected_frame_height {
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

    if let Some(frame) = latest_bgra.as_ref() {
      if let Err(error) = encoder.send_frame_buffer(frame, frame_index_100ns) {
        eprintln!("[VelocityCapture] Failed to encode webcam frame: {error}");
      }
      // Advance even when the encode failed, so the two tracks end the same
      // length -- but never past the clock, so they also end at the same time.
      frame_index_100ns = advance_stamp(
        frame_index_100ns,
        frame_period_100ns,
        (started.elapsed().as_nanos() / 100) as i64,
      );
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
) -> napi::Result<Stopper> {
  let (stop_tx, stop_rx) = channel();
  let (done_tx, done_rx) = channel();
  let (ready_tx, ready_rx) = channel();
  let output_path = output_path.to_string();

  thread::spawn(move || {
    run_webcam_recording_loop(output_path, source, target_fps, stop_rx, ready_tx);
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
      Path::new(&sidecar).extension().and_then(|value| value.to_str()),
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

  #[test]
  fn rgb_to_bgra_bottom_up_converts_channel_order_and_flips_rows() {
    let width = 1;
    let height = 2;
    // Row 0 (top, decoded order): R=10,G=20,B=30. Row 1 (bottom): R=40,G=50,B=60.
    let rgb = vec![10, 20, 30, 40, 50, 60];
    let bgra = rgb_to_bgra_bottom_up(&rgb, width, height);

    assert_eq!(bgra.len(), width * height * 4);
    // Bottom-up output: row 0 of the output holds the *last* source row.
    assert_eq!(&bgra[0..4], &[60, 50, 40, 255]);
    assert_eq!(&bgra[4..8], &[30, 20, 10, 255]);
  }

  #[test]
  fn rgb_to_bgra_bottom_up_sets_full_opacity_alpha_for_every_pixel() {
    let width = 2;
    let height = 1;
    let rgb = vec![1, 2, 3, 4, 5, 6];
    let bgra = rgb_to_bgra_bottom_up(&rgb, width, height);
    assert_eq!(bgra[3], 255);
    assert_eq!(bgra[7], 255);
  }

  #[test]
  fn rgb_to_bgra_bottom_up_produces_identity_flip_for_single_row() {
    let width = 2;
    let height = 1;
    let rgb = vec![9, 8, 7, 6, 5, 4];
    let bgra = rgb_to_bgra_bottom_up(&rgb, width, height);
    // A single-row image is its own vertical flip.
    assert_eq!(&bgra[0..4], &[7, 8, 9, 255]);
    assert_eq!(&bgra[4..8], &[4, 5, 6, 255]);
  }
}
