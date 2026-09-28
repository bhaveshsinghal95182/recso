//! Window listing for platforms without a native implementation yet.
//!
//! Same exports as `window.rs`. An empty list leaves the picker with nothing
//! to offer, which the recorder already handles.

use napi_derive::napi;

#[napi(object)]
pub struct WindowInfo {
  pub title: String,
  pub class_name: String,
  pub thumbnail_data_url: Option<String>,
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
}

#[napi]
pub fn list_available_windows() -> napi::Result<Vec<WindowInfo>> {
  Ok(Vec::new())
}
