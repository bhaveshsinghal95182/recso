//! # Types Module
//!
//! Shared data structures for mouse/keyboard events and smoothing options.
//! All types are compatible with N-API for JavaScript interop.

use napi_derive::napi;
use serde::Serialize;

/// Type of mouse event
#[napi(string_enum = "lowercase")]
#[derive(Serialize, Clone, Debug)]
pub enum MouseEventType {
    Move,
    MouseDown,
    MouseUp,
    Scroll,
}

/// Mouse event data sent to JavaScript
#[derive(Serialize, Clone)]
#[napi(object)]
pub struct MouseEvent {
    pub x: i32,
    pub y: i32,
    pub event_type: MouseEventType,
    pub button: Option<String>,
    pub scroll_delta: Option<i32>,
    pub timestamp: i64,
}

/// Keyboard event data sent to JavaScript
#[derive(Serialize, Clone)]
#[napi(object)]
pub struct KeyboardEvent {
    pub key_code: u32,
    pub event_type: String,
    pub timestamp: i64,
}

/// Type of event stored in database and used for smoothing
#[napi(string_enum = "lowercase")]
#[derive(Serialize, Clone, Debug, PartialEq)] // Added PartialEq for comparisons
pub enum SmoothingEventType {
    Move,
    Click,
    Drag,
    Scroll,
}

/// Raw mouse event from database/buffer (input to smoothing)
#[derive(Clone)]
#[napi(object)]
pub struct RawMouseEvent {
    pub recording_id: String,
    pub timestamp_ms: f64,
    pub x: f64,
    pub y: f64,
    pub event_type: SmoothingEventType,
    pub button: Option<String>,
}

/// Smoothed/interpolated point (output from smoothing)
#[derive(Clone)]
#[napi(object)]
pub struct SmoothedPoint {
    pub recording_id: String,
    pub timestamp_ms: f64,
    pub x: f64,
    pub y: f64,
    pub event_type: String, // Output is string for easy consumption in JS (or could be enum)
    pub button: Option<String>,
    pub is_interpolated: bool,
}

/// Options for mouse path processing
#[napi(object)]
pub struct SmoothingOptions {
    /// Target FPS for upsampling (default: 60)
    pub target_fps: Option<f64>,
    /// Spline tension (0-1, lower = smoother, default: 0.5)
    pub tension: Option<f64>,
    /// Jitter removal threshold in pixels (default: 2.0)
    pub jitter_threshold: Option<f64>,
    /// Whether to apply jitter removal (default: true)
    pub remove_jitter: Option<bool>,
}
