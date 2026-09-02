mod borderless;
mod desktop_capture;
mod recording_info;
mod webcam_capture;

use napi_derive::napi;

pub use desktop_capture::{start_monitor_recording, start_window_recording, Stopper};
pub use borderless::borderless_capture_allowed;
pub use recording_info::{RecordingMediaInfo, RecordingStats};
pub use webcam_capture::{list_webcam_devices, WebcamDeviceInfo};

#[napi(object)]
pub struct NativeRecordingOptions {
  pub output_path: String,
  pub bitrate: u32,
  pub include_system_audio: Option<bool>,
  pub target_fps: Option<u32>,
  pub enable_webcam: Option<bool>,
  pub webcam_device_id: Option<String>,
}

#[napi(object)]
pub struct NativeWindowRecordingOptions {
  pub window_title: String,
  pub output_path: String,
  pub bitrate: u32,
  pub include_system_audio: Option<bool>,
  pub target_fps: Option<u32>,
  pub enable_webcam: Option<bool>,
  pub webcam_device_id: Option<String>,
}

fn attach_webcam_stopper_if_requested(
  stopper: &mut Stopper,
  output_path: &str,
  enable_webcam: Option<bool>,
  webcam_device_id: Option<String>,
  target_fps: Option<u32>,
  api_name: &str,
) -> napi::Result<()> {
  if !enable_webcam.unwrap_or(false) {
    return Ok(());
  }

  match webcam_capture::start_webcam_sidecar_recording(output_path, webcam_device_id, target_fps) {
    Ok(webcam_stopper) => {
      stopper.append(webcam_stopper);
      Ok(())
    }
    Err(error) => {
      // Stop desktop capture immediately when webcam startup fails in v2 mode.
      stopper.stop();
      Err(napi::Error::from_reason(format!(
        "{}: {}",
        api_name,
        error
      )))
    }
  }
}

#[napi]
pub fn start_monitor_recording_v2(options: NativeRecordingOptions) -> napi::Result<Stopper> {
  let output_path = options.output_path.clone();
  let mut stopper = desktop_capture::start_monitor_recording_with_target_fps(
    options.output_path,
    options.bitrate,
    options.include_system_audio,
    options.target_fps,
  )?;

  attach_webcam_stopper_if_requested(
    &mut stopper,
    &output_path,
    options.enable_webcam,
    options.webcam_device_id,
    options.target_fps,
    "start_monitor_recording_v2 failed to start webcam",
  )?;

  Ok(stopper)
}

#[napi]
pub fn start_window_recording_v2(options: NativeWindowRecordingOptions) -> napi::Result<Stopper> {
  let output_path = options.output_path.clone();
  let mut stopper = desktop_capture::start_window_recording_with_target_fps(
    options.window_title,
    options.output_path,
    options.bitrate,
    options.include_system_audio,
    options.target_fps,
  )?;

  attach_webcam_stopper_if_requested(
    &mut stopper,
    &output_path,
    options.enable_webcam,
    options.webcam_device_id,
    options.target_fps,
    "start_window_recording_v2 failed to start webcam",
  )?;

  Ok(stopper)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::mpsc::channel;

  fn dummy_stopper() -> Stopper {
    let (stop_tx, _stop_rx) = channel::<()>();
    let (_done_tx, done_rx) = channel::<()>();
    Stopper::from_channels(stop_tx, done_rx)
  }

  #[test]
  fn attach_webcam_stopper_is_a_noop_when_enable_webcam_is_false() {
    let mut stopper = dummy_stopper();
    let result = attach_webcam_stopper_if_requested(
      &mut stopper,
      "out.mp4",
      Some(false),
      None,
      None,
      "test",
    );
    assert!(result.is_ok());
  }

  #[test]
  fn attach_webcam_stopper_is_a_noop_when_enable_webcam_is_omitted() {
    let mut stopper = dummy_stopper();
    let result =
      attach_webcam_stopper_if_requested(&mut stopper, "out.mp4", None, None, None, "test");
    assert!(result.is_ok());
  }
}
