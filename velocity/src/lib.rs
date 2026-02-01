//! # Velocity
//!
//! A high-performance native addon for Electron apps providing:
//!
//! - **Input Hooks**: Low-level Windows mouse and keyboard event capture
//! - **Mouse Smoothing**: Catmull-Rom spline interpolation and jitter removal
//! - **Screen Recording**: Native cursor-free screen capture via windows-capture
//! - **Monitor Enumeration**: Native monitor listing for source selection
//!
//! This crate is designed to be used via N-API from JavaScript/TypeScript.

#![deny(clippy::all)]

pub mod hooks;
pub mod monitor;
pub mod recorder;
pub mod smoothing;
pub mod types;
pub mod utils;

pub use hooks::{is_hook_running, start_input_hook, start_keyboard_hook, start_mouse_hook, stop_hook};
pub use monitor::{get_monitors, get_primary_monitor, MonitorSource};
pub use recorder::{
    is_paused, is_recording, pause_recording, resume_recording, start_recording, stop_recording,
    RecordingConfig,
};
pub use smoothing::{interpolate_position_at, process_mouse_path};
pub use types::{KeyboardEvent, MouseEvent, RawMouseEvent, SmoothedPoint, SmoothingOptions};

