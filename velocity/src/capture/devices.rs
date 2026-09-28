//! The device descriptions the recorder UI lists, shared by every backend.

use napi_derive::napi;

#[napi(object)]
pub struct WebcamDeviceInfo {
  pub id: String,
  pub label: String,
  pub is_default: bool,
}

/// One recording device the machine can hear from.
#[napi(object)]
pub struct AudioDeviceInfo {
  /// The WASAPI endpoint id. Stable across renames, unlike the label.
  pub id: String,
  pub label: String,
  pub is_default: bool,
}
