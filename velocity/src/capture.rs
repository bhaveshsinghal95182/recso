#[cfg(windows)]
mod borderless;
#[cfg(windows)]
mod desktop_capture;
mod camera;
mod devices;
#[cfg(target_os = "linux")]
pub(crate) mod linux;
mod phone_camera;
mod pixels;
mod preview;
mod recording_info;
mod stopper;
#[cfg(not(windows))]
mod unsupported;
#[cfg(windows)]
mod webcam_capture;

/// Capture-side scenarios and matrices.
///
/// The recorder's own units are hard to test -- they end in a Windows API call
/// -- but the decisions in front of those calls are not: which camera was
/// asked for, what rate was resolved, where the sidecar is written, and what
/// the stats say about a take once it is over.
#[cfg(test)]
mod scenarios;

use napi_derive::napi;

pub use devices::{AudioDeviceInfo, WebcamDeviceInfo};
pub use phone_camera::{
  phone_camera_status, push_phone_frame, reset_phone_camera, PhoneCameraStatus,
};
pub use preview::{clear_webcam_preview_frame, webcam_preview_frame, WebcamPreviewFrame};
pub use recording_info::{RecordingMediaInfo, RecordingStats};
pub use stopper::Stopper;

// The platform backends. Each exposes the same functions, so the recording
// entry points below and the JavaScript API are identical on every platform.
#[cfg(windows)]
use desktop_capture as screen_backend;
#[cfg(target_os = "linux")]
use linux::screen as screen_backend;
#[cfg(not(any(windows, target_os = "linux")))]
use unsupported as screen_backend;
#[cfg(windows)]
use webcam_capture as camera_backend;
#[cfg(target_os = "linux")]
use linux::webcam as camera_backend;
#[cfg(not(any(windows, target_os = "linux")))]
use unsupported as camera_backend;

pub use camera_backend::{list_webcam_devices, start_webcam_preview};
#[cfg(windows)]
pub use borderless::borderless_capture_allowed;
#[cfg(not(windows))]
pub use unsupported::borderless_capture_allowed;
#[cfg(windows)]
pub use desktop_capture::list_audio_capture_devices;
#[cfg(target_os = "linux")]
pub use linux::list_audio_capture_devices;
#[cfg(not(any(windows, target_os = "linux")))]
pub use unsupported::list_audio_capture_devices;

/// Which camera a recording is using.
pub(crate) enum WebcamSource {
  /// A camera attached to this machine, by device id or the default.
  Local(Option<String>),
  /// A phone streaming over the local network, already paired and sending.
  Phone,
}

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
  /// Which microphone, as an id from `listAudioCaptureDevices`. Omitted takes
  /// the system default.
  ///
  /// Not a browser `enumerateDevices` id -- those are salted per origin and
  /// mean nothing to WASAPI, which is why the microphone chosen in the renderer
  /// used to be ignored here.
  pub microphone_device_id: Option<String>,
  pub target_fps: Option<u32>,
  pub enable_webcam: Option<bool>,
  pub webcam_device_id: Option<String>,
  /// "local" (the default) or "phone". A phone must already be paired and
  /// sending frames before the recording starts.
  pub webcam_source: Option<String>,
  /// Linux: ask the portal to remember the source the user picks. Read the
  /// token back with `Stopper.portalRestoreToken()`. Ignored elsewhere.
  pub remember_source: Option<bool>,
  /// Linux: a token from an earlier remembered recording, which reopens the
  /// same source without the picker. Only used with `remember_source`.
  pub portal_restore_token: Option<String>,
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
  /// Which microphone, as an id from `listAudioCaptureDevices`. Omitted takes
  /// the system default.
  ///
  /// Not a browser `enumerateDevices` id -- those are salted per origin and
  /// mean nothing to WASAPI, which is why the microphone chosen in the renderer
  /// used to be ignored here.
  pub microphone_device_id: Option<String>,
  pub target_fps: Option<u32>,
  pub enable_webcam: Option<bool>,
  pub webcam_device_id: Option<String>,
  /// "local" (the default) or "phone". A phone must already be paired and
  /// sending frames before the recording starts.
  pub webcam_source: Option<String>,
  /// Linux: ask the portal to remember the source the user picks. Read the
  /// token back with `Stopper.portalRestoreToken()`. Ignored elsewhere.
  pub remember_source: Option<bool>,
  /// Linux: a token from an earlier remembered recording, which reopens the
  /// same source without the picker. Only used with `remember_source`.
  pub portal_restore_token: Option<String>,
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

  let screen_stats = stopper.screen_stats().ok_or_else(|| {
    napi::Error::from_reason("screen capture clock is unavailable")
  })?;
  match camera_backend::start_webcam_sidecar_recording(output_path, source, target_fps, screen_stats) {
    Ok(webcam_stopper) => {
      stopper.append(webcam_stopper);
      Ok(())
    }
    Err(error) => {
      // Stop desktop capture immediately when webcam startup fails in v2 mode.
      stopper.stop();
      Err(napi::Error::from_reason(format!("{}: {}", api_name, error)))
    }
  }
}

#[napi]
pub fn start_monitor_recording_v2(options: NativeRecordingOptions) -> napi::Result<Stopper> {
  let output_path = options.output_path.clone();
  #[cfg(target_os = "linux")]
  let mut stopper = screen_backend::start_monitor_recording_with_portal(
    options.output_path,
    options.bitrate,
    options.include_system_audio,
    options.include_microphone,
    options.microphone_device_id,
    options.target_fps,
    linux::portal::PortalRequest {
      remember: options.remember_source.unwrap_or(false),
      restore_token: options.portal_restore_token,
    },
  )?;
  #[cfg(not(target_os = "linux"))]
  let mut stopper = screen_backend::start_monitor_recording_with_target_fps(
    options.output_path,
    options.bitrate,
    options.include_system_audio,
    options.include_microphone,
    options.microphone_device_id,
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
  // Wayland has no window list: the portal's picker offers windows too, so a
  // window recording is a monitor recording that may remember its source.
  #[cfg(target_os = "linux")]
  let mut stopper = screen_backend::start_monitor_recording_with_portal(
    options.output_path,
    options.bitrate,
    options.include_system_audio,
    options.include_microphone,
    options.microphone_device_id,
    options.target_fps,
    linux::portal::PortalRequest {
      remember: options.remember_source.unwrap_or(false),
      restore_token: options.portal_restore_token,
    },
  )?;
  #[cfg(not(target_os = "linux"))]
  let mut stopper = screen_backend::start_window_recording_with_target_fps(
    options.window_title,
    options.output_path,
    options.bitrate,
    options.include_system_audio,
    options.include_microphone,
    options.microphone_device_id,
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

#[cfg(test)]
mod webcam_source_scenarios {
  use super::*;

  fn local_id(source: napi::Result<WebcamSource>) -> Option<String> {
    match source {
      Ok(WebcamSource::Local(id)) => id,
      Ok(WebcamSource::Phone) => panic!("expected a local camera, got the phone"),
      Err(error) => panic!("expected a local camera, got {}", error.reason),
    }
  }

  /// `unwrap_err` would need `WebcamSource: Debug`, which it has no other
  /// reason to be.
  fn refusal(source: &str) -> String {
    match parse_webcam_source(Some(source.to_string()), None) {
      Err(error) => error.reason.clone(),
      Ok(_) => panic!("{source} was accepted"),
    }
  }

  #[test]
  fn no_source_named_means_the_camera_attached_to_this_machine() {
    assert!(matches!(
      parse_webcam_source(None, None),
      Ok(WebcamSource::Local(None))
    ));
  }

  #[test]
  fn an_empty_source_means_the_local_camera_too() {
    // The editor sends "" for "not set" in a couple of places, and treating it
    // as an unknown source would refuse a recording that used to work.
    assert!(matches!(
      parse_webcam_source(Some(String::new()), None),
      Ok(WebcamSource::Local(None))
    ));
  }

  #[test]
  fn the_local_camera_can_be_asked_for_by_name() {
    assert!(matches!(
      parse_webcam_source(Some("local".to_string()), None),
      Ok(WebcamSource::Local(None))
    ));
  }

  #[test]
  fn a_device_id_rides_along_with_the_local_camera() {
    let id = local_id(parse_webcam_source(None, Some("cam-7".to_string())));
    assert_eq!(id.as_deref(), Some("cam-7"));
  }

  #[test]
  fn a_device_id_survives_an_explicit_local_source() {
    let id = local_id(parse_webcam_source(
      Some("local".to_string()),
      Some("cam-7".to_string()),
    ));
    assert_eq!(id.as_deref(), Some("cam-7"));
  }

  #[test]
  fn a_device_id_survives_an_empty_source() {
    let id = local_id(parse_webcam_source(
      Some(String::new()),
      Some("cam-7".to_string()),
    ));
    assert_eq!(id.as_deref(), Some("cam-7"));
  }

  #[test]
  fn a_phone_is_asked_for_by_name_rather_than_by_a_made_up_device_id() {
    // A phone is not a device the machine has, so asking for it by id would
    // mean inventing an id `listWebcamDevices` can never return.
    assert!(matches!(
      parse_webcam_source(Some("phone".to_string()), None),
      Ok(WebcamSource::Phone)
    ));
  }

  #[test]
  fn a_device_id_is_ignored_when_the_phone_is_asked_for() {
    assert!(matches!(
      parse_webcam_source(Some("phone".to_string()), Some("cam-7".to_string())),
      Ok(WebcamSource::Phone)
    ));
  }

  #[test]
  fn an_unknown_source_is_refused_rather_than_guessed() {
    // Silently falling back would record the wrong camera, and the user would
    // not find out until they opened the editor.
    for name in ["laptop", "usb", "webcam", "default", "0"] {
      assert!(
        parse_webcam_source(Some(name.to_string()), None).is_err(),
        "{name}"
      );
    }
  }

  #[test]
  fn the_source_names_are_case_sensitive() {
    // The caller is a serialiser, so a capital is a bug on the sending side
    // rather than something to be forgiving about.
    for name in ["Phone", "PHONE", "Local", "LOCAL"] {
      assert!(
        parse_webcam_source(Some(name.to_string()), None).is_err(),
        "{name}"
      );
    }
  }

  #[test]
  fn a_padded_source_name_is_not_trimmed() {
    assert!(parse_webcam_source(Some(" phone ".to_string()), None).is_err());
  }

  #[test]
  fn the_refusal_names_the_source_it_did_not_understand() {
    let message = refusal("laptop");
    assert!(message.contains("laptop"), "{message}");
  }

  #[test]
  fn the_refusal_says_what_would_have_worked() {
    let message = refusal("laptop");
    assert!(message.contains("local"), "{message}");
    assert!(message.contains("phone"), "{message}");
  }

  #[test]
  fn every_accepted_spelling_produces_a_source_the_recorder_can_open() {
    let accepted: [Option<String>; 3] = [None, Some(String::new()), Some("local".to_string())];
    for source in accepted {
      assert!(
        parse_webcam_source(source.clone(), None).is_ok(),
        "{source:?}"
      );
    }
    assert!(parse_webcam_source(Some("phone".to_string()), None).is_ok());
  }
}
