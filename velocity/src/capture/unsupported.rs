//! The capture backend for platforms without one yet.
//!
//! Same functions as the Windows backend, so the crate and its JavaScript API
//! build everywhere. Listing calls report no devices; anything that would start
//! a capture fails with an error saying why, rather than recording nothing.

#[cfg(not(target_os = "linux"))]
use std::sync::Arc;

use napi_derive::napi;

#[cfg(not(target_os = "linux"))]
use super::devices::AudioDeviceInfo;
#[cfg(not(target_os = "linux"))]
use super::devices::WebcamDeviceInfo;
#[cfg(not(target_os = "linux"))]
use super::recording_info::RecordingStats;
use super::stopper::Stopper;
#[cfg(not(target_os = "linux"))]
use super::WebcamSource;

fn unsupported(what: &str) -> napi::Error {
  napi::Error::from_reason(format!(
    "{what} is not supported on {} yet",
    std::env::consts::OS
  ))
}

#[napi]
pub fn borderless_capture_allowed() -> bool {
  false
}

// Linux lists its PipeWire sources instead (capture/linux.rs).
#[cfg(not(target_os = "linux"))]
#[napi]
pub fn list_audio_capture_devices() -> Vec<AudioDeviceInfo> {
  Vec::new()
}

#[cfg(not(target_os = "linux"))]
#[napi]
pub fn list_webcam_devices() -> Vec<WebcamDeviceInfo> {
  Vec::new()
}

#[cfg(not(target_os = "linux"))]
#[napi]
pub fn start_webcam_preview(_device_id: Option<String>) -> napi::Result<Stopper> {
  Err(unsupported("webcam preview"))
}

pub(crate) fn start_monitor_recording_with_target_fps(
  _output_path: String,
  _bitrate: u32,
  _include_system_audio: Option<bool>,
  _include_microphone: Option<bool>,
  _microphone_device_id: Option<String>,
  _target_fps: Option<u32>,
) -> napi::Result<Stopper> {
  Err(unsupported("screen recording"))
}

pub(crate) fn start_window_recording_with_target_fps(
  _window_title: String,
  _output_path: String,
  _bitrate: u32,
  _include_system_audio: Option<bool>,
  _include_microphone: Option<bool>,
  _microphone_device_id: Option<String>,
  _target_fps: Option<u32>,
) -> napi::Result<Stopper> {
  Err(unsupported("window recording"))
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn start_webcam_sidecar_recording(
  _output_path: &str,
  _source: WebcamSource,
  _target_fps: Option<u32>,
  _screen_stats: Arc<RecordingStats>,
) -> napi::Result<Stopper> {
  Err(unsupported("webcam recording"))
}
