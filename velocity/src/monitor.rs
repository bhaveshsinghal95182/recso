//! Monitor enumeration for native screen capture
//!
//! Uses `windows-capture` to enumerate available monitors for recording.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use windows_capture::monitor::Monitor;

/// Information about a capturable monitor source
#[napi(object)]
#[derive(Clone)]
pub struct MonitorSource {
    /// One-based index of the monitor
    pub index: u32,
    /// Friendly name of the monitor
    pub name: String,
    /// Device name (e.g., \\.\DISPLAY1)
    pub device_name: String,
    /// Width in pixels
    pub width: u32,
    /// Height in pixels
    pub height: u32,
    /// Whether this is the primary monitor
    pub is_primary: bool,
}

/// Get all available monitors for recording
#[napi]
pub fn get_monitors() -> Result<Vec<MonitorSource>> {
    let monitors = Monitor::enumerate()
        .map_err(|e| Error::from_reason(format!("Failed to enumerate monitors: {}", e)))?;

    let primary = Monitor::primary().ok();
    let primary_index = primary.and_then(|p| p.index().ok());

    let mut sources = Vec::new();

    for monitor in monitors {
        let index = monitor.index().unwrap_or(0);
        let name = monitor.name().unwrap_or_else(|_| format!("Monitor {}", index));
        let device_name = monitor.device_name().unwrap_or_default();
        let width = monitor.width().unwrap_or(0);
        let height = monitor.height().unwrap_or(0);
        let is_primary = Some(index) == primary_index;

        sources.push(MonitorSource {
            index: index as u32,
            name,
            device_name,
            width,
            height,
            is_primary,
        });
    }

    Ok(sources)
}

/// Get the primary monitor
#[napi]
pub fn get_primary_monitor() -> Result<MonitorSource> {
    let monitor = Monitor::primary()
        .map_err(|e| Error::from_reason(format!("Failed to get primary monitor: {}", e)))?;

    let index = monitor.index().unwrap_or(1);
    let name = monitor.name().unwrap_or_else(|_| "Primary Monitor".to_string());
    let device_name = monitor.device_name().unwrap_or_default();
    let width = monitor.width().unwrap_or(0);
    let height = monitor.height().unwrap_or(0);

    Ok(MonitorSource {
        index: index as u32,
        name,
        device_name,
        width,
        height,
        is_primary: true,
    })
}
