//! # Utilities Module
//!
//! Common helper functions used across the crate.

/// Get current timestamp in milliseconds since UNIX epoch.
///
/// Uses `unwrap_or_default()` to gracefully handle edge cases where
/// the system clock is set before 1970 (returns 0 instead of panicking).
pub fn current_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
