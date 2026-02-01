//! # Keyboard Hook Procedure
//!
//! Low-level Windows keyboard hook callback. This runs on the hook thread
//! and forwards events to JavaScript via N-API threadsafe functions.
//!
//! ## Safety
//!
//! This module contains `unsafe` code for Windows FFI. The hook procedure
//! is called by Windows and must not panic or block.

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, KBDLLHOOKSTRUCT, WM_KEYDOWN,
    WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use crate::types::KeyboardEvent;
use crate::utils::current_timestamp;
use super::state::KEYBOARD_CALLBACK;

/// Low-level keyboard hook procedure
pub unsafe extern "system" fn keyboard_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb_struct = *(lparam.0 as *const KBDLLHOOKSTRUCT);

        let event_type = match wparam.0 as u32 {
            WM_KEYDOWN | WM_SYSKEYDOWN => "keydown",
            WM_KEYUP | WM_SYSKEYUP => "keyup",
            _ => "",
        };

        if !event_type.is_empty() {
            let event = KeyboardEvent {
                key_code: kb_struct.vkCode,
                event_type: event_type.to_string(),
                timestamp: current_timestamp(),
            };

            if let Ok(guard) = KEYBOARD_CALLBACK.lock() {
                if let Some(ref callback) = *guard {
                    let _ = callback.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
                }
            }
        }
    }

    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
