//! # Hooks Module
//!
//! This module provides Windows low-level input hooks for capturing mouse and keyboard events.
//! It exposes N-API functions that can be called from JavaScript/TypeScript.
//!
//! ## Usage
//!
//! ```javascript
//! import { startMouseHook, stopHook } from 'velocity';
//!
//! startMouseHook((err, event) => {
//!   if (err) return console.error(err);
//!   console.log('Mouse:', event.x, event.y);
//! });
//!
//! // Later:
//! stopHook();
//! ```
//!
//! ## Thread Safety
//!
//! The hooks run on a dedicated thread with a Windows message loop. Callbacks are
//! invoked via N-API's threadsafe functions, ensuring safe cross-thread communication.

use std::sync::atomic::Ordering;
use std::thread;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use windows::Win32::Foundation::{HMODULE, LPARAM, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, MSG, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_QUIT,
};

use crate::types::{KeyboardEvent, MouseEvent};

pub mod keyboard;
pub mod mouse;
pub mod state;

use self::keyboard::keyboard_hook_proc;
use self::mouse::mouse_hook_proc;
use self::state::{
    SendableHook, HOOK_THREAD_ID, KEYBOARD_CALLBACK, KEYBOARD_HOOK, MOUSE_CALLBACK, MOUSE_HOOK,
    RUNNING,
};

/// Start monitoring mouse events.
///
/// The callback will be called for each mouse event (move, click, scroll).
/// Only one hook can be active at a time. Call `stop_hook()` before starting a new one.
#[napi(ts_args_type = "callback: (err: null | Error, event: MouseEvent) => void")]
pub fn start_mouse_hook(callback: ThreadsafeFunction<MouseEvent>) -> Result<()> {
    if RUNNING.load(Ordering::SeqCst) {
        return Err(Error::new(Status::GenericFailure, "Hook already running"));
    }

    // Store callback - if lock is poisoned, return error
    {
        let mut guard = MOUSE_CALLBACK
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "Failed to acquire callback lock"))?;
        *guard = Some(callback);
    }

    RUNNING.store(true, Ordering::SeqCst);

    // Spawn hook thread
    thread::spawn(|| {
        unsafe {
            // Store thread ID for later message posting
            let thread_id = windows::Win32::System::Threading::GetCurrentThreadId();
            if let Ok(mut guard) = HOOK_THREAD_ID.lock() {
                *guard = Some(thread_id);
            }

            let h_instance: HMODULE =
                GetModuleHandleW(None).unwrap_or(HMODULE(std::ptr::null_mut()));

            // Install mouse hook
            let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), h_instance, 0);
            if let Ok(hook) = mouse_hook {
                if let Ok(mut guard) = MOUSE_HOOK.lock() {
                    *guard = Some(SendableHook(hook));
                }
            }

            // Message loop - required for low-level hooks
            let mut msg = MSG::default();
            while RUNNING.load(Ordering::SeqCst) {
                let result = GetMessageW(&mut msg, None, 0, 0);
                if result.0 <= 0 {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            // Cleanup hooks
            if let Ok(guard) = MOUSE_HOOK.lock() {
                if let Some(ref hook) = *guard {
                    let _ = UnhookWindowsHookEx(hook.0);
                }
            }
        }
    });

    Ok(())
}

/// Start monitoring keyboard events.
///
/// The callback will be called for each keyboard event (keydown, keyup).
/// Only one hook can be active at a time.
#[napi(ts_args_type = "callback: (err: null | Error, event: KeyboardEvent) => void")]
pub fn start_keyboard_hook(callback: ThreadsafeFunction<KeyboardEvent>) -> Result<()> {
    if RUNNING.load(Ordering::SeqCst) {
        return Err(Error::new(
            Status::GenericFailure,
            "Hook already running, stop first",
        ));
    }

    // Store callback
    {
        let mut guard = KEYBOARD_CALLBACK
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "Failed to acquire callback lock"))?;
        *guard = Some(callback);
    }

    RUNNING.store(true, Ordering::SeqCst);

    thread::spawn(|| {
        unsafe {
            let thread_id = windows::Win32::System::Threading::GetCurrentThreadId();
            if let Ok(mut guard) = HOOK_THREAD_ID.lock() {
                *guard = Some(thread_id);
            }

            let h_instance: HMODULE =
                GetModuleHandleW(None).unwrap_or(HMODULE(std::ptr::null_mut()));

            let keyboard_hook =
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), h_instance, 0);
            if let Ok(hook) = keyboard_hook {
                if let Ok(mut guard) = KEYBOARD_HOOK.lock() {
                    *guard = Some(SendableHook(hook));
                }
            }

            let mut msg = MSG::default();
            while RUNNING.load(Ordering::SeqCst) {
                let result = GetMessageW(&mut msg, None, 0, 0);
                if result.0 <= 0 {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            if let Ok(guard) = KEYBOARD_HOOK.lock() {
                if let Some(ref hook) = *guard {
                    let _ = UnhookWindowsHookEx(hook.0);
                }
            }
        }
    });

    Ok(())
}

/// Start monitoring both mouse and keyboard events simultaneously.
///
/// This is more efficient than calling `start_mouse_hook` and `start_keyboard_hook`
/// separately as it uses a single thread for both hooks.
#[napi(ts_args_type = "mouseCallback: (err: null | Error, event: MouseEvent) => void, keyboardCallback: (err: null | Error, event: KeyboardEvent) => void")]
pub fn start_input_hook(
    mouse_callback: ThreadsafeFunction<MouseEvent>,
    keyboard_callback: ThreadsafeFunction<KeyboardEvent>,
) -> Result<()> {
    if RUNNING.load(Ordering::SeqCst) {
        return Err(Error::new(Status::GenericFailure, "Hook already running"));
    }

    // Store callbacks
    {
        let mut guard = MOUSE_CALLBACK
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "Failed to acquire mouse callback lock"))?;
        *guard = Some(mouse_callback);
    }
    {
        let mut guard = KEYBOARD_CALLBACK
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "Failed to acquire keyboard callback lock"))?;
        *guard = Some(keyboard_callback);
    }

    RUNNING.store(true, Ordering::SeqCst);

    thread::spawn(|| {
        unsafe {
            let thread_id = windows::Win32::System::Threading::GetCurrentThreadId();
            if let Ok(mut guard) = HOOK_THREAD_ID.lock() {
                *guard = Some(thread_id);
            }

            let h_instance: HMODULE =
                GetModuleHandleW(None).unwrap_or(HMODULE(std::ptr::null_mut()));

            // Install both hooks
            let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), h_instance, 0);
            if let Ok(hook) = mouse_hook {
                if let Ok(mut guard) = MOUSE_HOOK.lock() {
                    *guard = Some(SendableHook(hook));
                }
            }

            let keyboard_hook =
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), h_instance, 0);
            if let Ok(hook) = keyboard_hook {
                if let Ok(mut guard) = KEYBOARD_HOOK.lock() {
                    *guard = Some(SendableHook(hook));
                }
            }

            // Message loop
            let mut msg = MSG::default();
            while RUNNING.load(Ordering::SeqCst) {
                let result = GetMessageW(&mut msg, None, 0, 0);
                if result.0 <= 0 {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            // Cleanup
            if let Ok(guard) = MOUSE_HOOK.lock() {
                if let Some(ref hook) = *guard {
                    let _ = UnhookWindowsHookEx(hook.0);
                }
            }
            if let Ok(guard) = KEYBOARD_HOOK.lock() {
                if let Some(ref hook) = *guard {
                    let _ = UnhookWindowsHookEx(hook.0);
                }
            }
        }
    });

    Ok(())
}

/// Stop all active hooks and clean up resources.
///
/// This is safe to call even if no hooks are running.
#[napi]
pub fn stop_hook() -> Result<()> {
    if !RUNNING.load(Ordering::SeqCst) {
        return Ok(());
    }

    RUNNING.store(false, Ordering::SeqCst);

    // Post WM_QUIT to break the message loop
    if let Ok(guard) = HOOK_THREAD_ID.lock() {
        if let Some(thread_id) = *guard {
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }

    // Clear callbacks - silently ignore poisoned locks during cleanup
    if let Ok(mut guard) = MOUSE_CALLBACK.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = KEYBOARD_CALLBACK.lock() {
        *guard = None;
    }

    Ok(())
}

/// Check if any hooks are currently running.
#[napi]
pub fn is_hook_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}
