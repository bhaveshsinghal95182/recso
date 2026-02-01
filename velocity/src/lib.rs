//! # Velocity
//!
//! A high-performance native addon for Electron apps providing:
//!
//! - **Input Hooks**: Low-level Windows mouse and keyboard event capture
//! - **Mouse Smoothing**: Catmull-Rom spline interpolation and jitter removal
//!
//! This crate is designed to be used via N-API from JavaScript/TypeScript.

#![deny(clippy::all)]

pub mod hooks;
pub mod smoothing;
pub mod types;
pub mod utils;

pub use hooks::{is_hook_running, start_input_hook, start_keyboard_hook, start_mouse_hook, stop_hook};
pub use smoothing::{interpolate_position_at, process_mouse_path};
pub use types::{KeyboardEvent, MouseEvent, RawMouseEvent, SmoothedPoint, SmoothingOptions};
