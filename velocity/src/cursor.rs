use napi_derive::napi;
use windows_capture::graphics_capture_api::GraphicsCaptureApi;

#[napi]
pub fn is_cursor_settings_supported() -> napi::Result<bool> {
    Ok(GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false))
}
