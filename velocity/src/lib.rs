#![deny(clippy::all)]
// Shared capture and layout code is written for every backend but, until the
// Linux backends land, only the Windows one uses all of it. The Windows build
// still reports genuine dead code.
#![cfg_attr(not(windows), allow(dead_code))]

pub mod capture;
#[cfg(windows)]
pub mod cursor;
#[cfg(target_os = "linux")]
#[path = "cursor_linux.rs"]
pub mod cursor;
#[cfg(not(any(windows, target_os = "linux")))]
#[path = "cursor_unsupported.rs"]
pub mod cursor;
pub mod engine;
pub mod singular_clock;
pub mod tls;
#[cfg(windows)]
pub mod window;
#[cfg(not(windows))]
#[path = "window_unsupported.rs"]
pub mod window;

/// Combination matrices for the frame clock: the pacing decisions swept across
/// the cross-product of drift, queue pressure and threshold, rather than one
/// hand-picked case per branch.
#[cfg(test)]
mod clock_matrix;

/// Regressions.
///
/// One test per defect this crate has actually had, named after the symptom
/// rather than the fix, so a reintroduction fails with a description of what
/// the user would have seen.
#[cfg(test)]
mod regressions;
