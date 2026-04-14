use super::desktop_capture::Stopper;
use crate::singular_clock::fps_to_period_100ns;
use napi_derive::napi;
use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{ApiBackend, CameraIndex, RequestedFormat, RequestedFormatType};
use nokhwa::{query, Camera};
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::thread;
use std::time::Duration;
use windows_capture::encoder::{
  AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
};

const WEBCAM_DEFAULT_BITRATE: u32 = 3_000_000;

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

fn rgb_to_bgra_bottom_up(rgb: &[u8], width: usize, height: usize) -> Vec<u8> {
  let mut output = vec![0u8; width.saturating_mul(height).saturating_mul(4)];

  for y in 0..height {
    let src_row_start = y.saturating_mul(width).saturating_mul(3);
    let dst_y = height.saturating_sub(1).saturating_sub(y);
    let dst_row_start = dst_y.saturating_mul(width).saturating_mul(4);

    for x in 0..width {
      let src = src_row_start + x.saturating_mul(3);
      let dst = dst_row_start + x.saturating_mul(4);

      if src + 2 >= rgb.len() || dst + 3 >= output.len() {
        continue;
      }

      let r = rgb[src];
      let g = rgb[src + 1];
      let b = rgb[src + 2];

      output[dst] = b;
      output[dst + 1] = g;
      output[dst + 2] = r;
      output[dst + 3] = 255;
    }
  }

  output
}

fn run_webcam_recording_loop(
  output_path: String,
  webcam_device_id: Option<String>,
  target_fps: Option<u32>,
  stop_rx: Receiver<()>,
  ready_tx: Sender<Result<(), String>>,
) {
  let sidecar_path = camera_sidecar_path(&output_path);
  let requested_fps = target_webcam_fps(target_fps);
  let camera_index = match select_camera_index(webcam_device_id.as_deref()) {
    Ok(index) => index,
    Err(error) => {
      let _ = ready_tx.send(Err(error));
      return;
    }
  };

  let mut camera = match create_camera(camera_index, requested_fps) {
    Ok(camera) => camera,
    Err(error) => {
      let _ = ready_tx.send(Err(error));
      return;
    }
  };

  if let Err(error) = camera.open_stream() {
    let _ = ready_tx.send(Err(format!("failed to open webcam stream: {error}")));
    return;
  }

  let camera_format = camera.camera_format();
  let width = camera_format.width();
  let height = camera_format.height();
  let effective_fps = if camera_format.frame_rate() > 0 {
    camera_format.frame_rate()
  } else {
    requested_fps
  };
  let frame_period_100ns = fps_to_period_100ns(effective_fps);

  let mut encoder = match VideoEncoder::new(
    VideoSettingsBuilder::new(width, height).bitrate(WEBCAM_DEFAULT_BITRATE),
    AudioSettingsBuilder::default().disabled(true),
    ContainerSettingsBuilder::default(),
    &sidecar_path,
  ) {
    Ok(encoder) => encoder,
    Err(error) => {
      let _ = camera.stop_stream();
      let _ = ready_tx.send(Err(format!("failed to initialize webcam encoder: {error}")));
      return;
    }
  };

  let _ = ready_tx.send(Ok(()));

  let frame_width = width as usize;
  let frame_height = height as usize;
  let mut frame_index_100ns: i64 = 0;

  loop {
    match stop_rx.try_recv() {
      Ok(_) | Err(TryRecvError::Disconnected) => break,
      Err(TryRecvError::Empty) => {}
    }

    let frame = match camera.frame() {
      Ok(frame) => frame,
      Err(error) => {
        eprintln!("[VelocityCapture] Failed to capture webcam frame: {error}");
        thread::sleep(Duration::from_millis(8));
        continue;
      }
    };

    let rgb_frame = match frame.decode_image::<RgbFormat>() {
      Ok(decoded) => decoded,
      Err(error) => {
        eprintln!("[VelocityCapture] Failed to decode webcam frame: {error}");
        continue;
      }
    };

    let rgb_raw = rgb_frame.into_raw();
    let bgra = rgb_to_bgra_bottom_up(&rgb_raw, frame_width, frame_height);

    if let Err(error) = encoder.send_frame_buffer(&bgra, frame_index_100ns) {
      eprintln!("[VelocityCapture] Failed to encode webcam frame: {error}");
      thread::sleep(Duration::from_millis(4));
      continue;
    }

    frame_index_100ns = frame_index_100ns.saturating_add(frame_period_100ns);
  }

  let _ = camera.stop_stream();
  let _ = encoder.finish();
}

pub(crate) fn start_webcam_sidecar_recording(
  output_path: &str,
  webcam_device_id: Option<String>,
  target_fps: Option<u32>,
) -> napi::Result<Stopper> {
  let (stop_tx, stop_rx) = channel();
  let (done_tx, done_rx) = channel();
  let (ready_tx, ready_rx) = channel();
  let output_path = output_path.to_string();

  thread::spawn(move || {
    run_webcam_recording_loop(output_path, webcam_device_id, target_fps, stop_rx, ready_tx);
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
