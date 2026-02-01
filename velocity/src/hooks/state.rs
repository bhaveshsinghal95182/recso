//! # Hook State Module
//!
//! Global state for Windows input hooks. This includes:
//!
//! - Atomic running flag for thread-safe status checks
//! - Mutex-protected hook handles and callbacks
//! - Thread ID for message loop communication
//!
//! ## Thread Safety
//!
//! All state is protected by `Mutex` or `AtomicBool` for safe cross-thread access.
//! The `SendableHook` wrapper makes Windows hook handles safely shareable.

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use napi::threadsafe_function::ThreadsafeFunction;
use windows::Win32::UI::WindowsAndMessaging::HHOOK;
use crate::types::{MouseEvent, KeyboardEvent};

/// Wrapper for HHOOK to make it Send + Sync safe
/// SAFETY: HHOOK is just a handle (pointer) that can be used from any thread
/// Windows hook handles are designed to be used across threads
pub struct SendableHook(pub HHOOK);
unsafe impl Send for SendableHook {}
unsafe impl Sync for SendableHook {}

// Global state for hooks
pub static RUNNING: AtomicBool = AtomicBool::new(false);
pub static MOUSE_HOOK: Mutex<Option<SendableHook>> = Mutex::new(None);
pub static KEYBOARD_HOOK: Mutex<Option<SendableHook>> = Mutex::new(None);
pub static HOOK_THREAD_ID: Mutex<Option<u32>> = Mutex::new(None);

// Thread-safe callbacks
pub static MOUSE_CALLBACK: Mutex<Option<ThreadsafeFunction<MouseEvent>>> = Mutex::new(None);
pub static KEYBOARD_CALLBACK: Mutex<Option<ThreadsafeFunction<KeyboardEvent>>> = Mutex::new(None);
