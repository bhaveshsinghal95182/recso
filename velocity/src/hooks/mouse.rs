//! # Mouse Hook Procedure
//!
//! Low-level Windows mouse hook callback. This runs on the hook thread
//! and forwards events to JavaScript via N-API threadsafe functions.
//!
//! ## Safety
//!
//! This module contains `unsafe` code for Windows FFI. The hook procedure
//! is called by Windows and must not panic or block.

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, MSLLHOOKSTRUCT, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN,
    WM_RBUTTONUP,
};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use crate::types::{MouseEvent, MouseEventType};
use crate::utils::current_timestamp;
use super::state::MOUSE_CALLBACK;

/// Low-level mouse hook procedure
pub unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let mouse_struct = *(lparam.0 as *const MSLLHOOKSTRUCT);

        let event_type = match wparam.0 as u32 {
            WM_MOUSEMOVE => Some(MouseEventType::Move),
            WM_LBUTTONDOWN => Some(MouseEventType::MouseDown),
            WM_LBUTTONUP => Some(MouseEventType::MouseUp),
            WM_RBUTTONDOWN => Some(MouseEventType::MouseDown),
            WM_RBUTTONUP => Some(MouseEventType::MouseUp),
            WM_MBUTTONDOWN => Some(MouseEventType::MouseDown),
            WM_MBUTTONUP => Some(MouseEventType::MouseUp),
            WM_MOUSEWHEEL => Some(MouseEventType::Scroll),
            _ => None,
        };

        if let Some(event_type) = event_type {
            let button = match wparam.0 as u32 {
                WM_LBUTTONDOWN | WM_LBUTTONUP => Some("left".to_string()),
                WM_RBUTTONDOWN | WM_RBUTTONUP => Some("right".to_string()),
                WM_MBUTTONDOWN | WM_MBUTTONUP => Some("middle".to_string()),
                _ => None,
            };

            let scroll_delta = if wparam.0 as u32 == WM_MOUSEWHEEL {
                // High-order word of mouseData contains the wheel delta
                Some((mouse_struct.mouseData as i32) >> 16)
            } else {
                None
            };

            let event = MouseEvent {
                x: mouse_struct.pt.x,
                y: mouse_struct.pt.y,
                event_type,
                button,
                scroll_delta,
                timestamp: current_timestamp(),
            };

            if let Ok(guard) = MOUSE_CALLBACK.lock() {
                if let Some(ref callback) = *guard {
                    let _ = callback.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
                }
            }
        }
    }

    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
