mod borderless;
mod desktop_capture;
mod phone_camera;
mod recording_info;
mod webcam_capture;

use napi_derive::napi;

pub use desktop_capture::{start_monitor_recording, start_window_recording, Stopper};
pub use borderless::borderless_capture_allowed;
pub use phone_camera::{
  phone_camera_status, push_phone_frame, reset_phone_camera, PhoneCameraStatus,
};
pub use recording_info::{RecordingMediaInfo, RecordingStats};
pub use webcam_capture::{list_webcam_devices, WebcamDeviceInfo};

use webcam_capture::WebcamSource;

/// Which camera a recording should use.
///
/// A named source rather than a magic device id, because "phone" is not a
/// device the machine has -- asking for it by id would mean inventing an id
/// that `listWebcamDevices` can never return, and every caller would have to
/// know the trick.
fn parse_webcam_source(
  source: Option<String>,
  device_id: Option<String>,
) -> napi::Result<WebcamSource> {
  match source.as_deref() {
    None | Some("") | Some("local") => Ok(WebcamSource::Local(device_id)),
    Some("phone") => Ok(WebcamSource::Phone),
    Some(other) => Err(napi::Error::from_reason(format!(
      "unknown webcam source {other:?}; expected \"local\" or \"phone\""
    ))),
  }
}

#[napi(object)]
pub struct NativeRecordingOptions {
  pub output_path: String,
  pub bitrate: u32,
  pub include_system_audio: Option<bool>,
  /// Record the default microphone into the same track as the video.
  ///
  /// Native rather than a renderer sidecar, so the voice is laid down against
  /// the picture's own timestamps instead of a second clock that has to be
  /// guessed back into alignment afterwards.
  pub include_microphone: Option<bool>,
  pub target_fps: Option<u32>,
  pub enable_webcam: Option<bool>,
  pub webcam_device_id: Option<String>,
  /// "local" (the default) or "phone". A phone must already be paired and
  /// sending frames before the recording starts.
  pub webcam_source: Option<String>,
}

#[napi(object)]
pub struct NativeWindowRecordingOptions {
  pub window_title: String,
  pub output_path: String,
  pub bitrate: u32,
  pub include_system_audio: Option<bool>,
  /// Record the default microphone into the same track as the video.
  ///
  /// Native rather than a renderer sidecar, so the voice is laid down against
  /// the picture's own timestamps instead of a second clock that has to be
  /// guessed back into alignment afterwards.
  pub include_microphone: Option<bool>,
  pub target_fps: Option<u32>,
  pub enable_webcam: Option<bool>,
  pub webcam_device_id: Option<String>,
  /// "local" (the default) or "phone". A phone must already be paired and
  /// sending frames before the recording starts.
  pub webcam_source: Option<String>,
}

fn attach_webcam_stopper_if_requested(
  stopper: &mut Stopper,
  output_path: &str,
  enable_webcam: Option<bool>,
  webcam_device_id: Option<String>,
  webcam_source: Option<String>,
  target_fps: Option<u32>,
  api_name: &str,
) -> napi::Result<()> {
  if !enable_webcam.unwrap_or(false) {
    return Ok(());
  }

  let source = match parse_webcam_source(webcam_source, webcam_device_id) {
    Ok(source) => source,
    Err(error) => {
      stopper.stop();
      return Err(error);
    }
  };

  match webcam_capture::start_webcam_sidecar_recording(output_path, source, target_fps) {
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
    options.include_microphone,
    options.target_fps,
  )?;

  attach_webcam_stopper_if_requested(
    &mut stopper,
    &output_path,
    options.enable_webcam,
    options.webcam_device_id,
    options.webcam_source,
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
    options.include_microphone,
    options.target_fps,
  )?;

  attach_webcam_stopper_if_requested(
    &mut stopper,
    &output_path,
    options.enable_webcam,
    options.webcam_device_id,
    options.webcam_source,
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
      None,
      "test",
    );
    assert!(result.is_ok());
  }

  #[test]
  fn attach_webcam_stopper_is_a_noop_when_enable_webcam_is_omitted() {
    let mut stopper = dummy_stopper();
    let result =
      attach_webcam_stopper_if_requested(&mut stopper, "out.mp4", None, None, None, None, "test");
    assert!(result.is_ok());
  }

  #[test]
  fn the_default_source_is_the_camera_attached_to_this_machine() {
    assert!(matches!(
      parse_webcam_source(None, Some("0".to_string())),
      Ok(WebcamSource::Local(Some(id))) if id == "0"
    ));
    assert!(matches!(
      parse_webcam_source(Some("local".to_string()), None),
      Ok(WebcamSource::Local(None))
    ));
  }

  #[test]
  fn a_phone_is_asked_for_by_name() {
    assert!(matches!(
      parse_webcam_source(Some("phone".to_string()), None),
      Ok(WebcamSource::Phone)
    ));
  }

  #[test]
  fn an_unknown_source_is_refused_rather_than_guessed() {
    // Silently falling back to the local camera would record the wrong one and
    // the user would not find out until they opened the editor.
    assert!(parse_webcam_source(Some("laptop".to_string()), None).is_err());
  }
}
