//! Cursor sampling for platforms without a native implementation yet.
//!
//! Same exports as `cursor.rs`. Callers already treat a failed snapshot as
//! "no cursor data", so failing clearly is safer than inventing positions.

use napi_derive::napi;

fn unsupported() -> napi::Error {
  napi::Error::from_reason(format!(
    "cursor sampling is not supported on {} yet",
    std::env::consts::OS
  ))
}

#[napi]
pub fn is_cursor_settings_supported() -> napi::Result<bool> {
  Ok(false)
}

#[napi]
pub fn capture_cursor_snapshot_json() -> napi::Result<String> {
  Err(unsupported())
}

#[napi]
pub fn capture_cursor_samples_json(
  _duration_ms: u32,
  _interval_ms: Option<u32>,
) -> napi::Result<String> {
  Err(unsupported())
}
