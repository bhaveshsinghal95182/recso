#![deny(clippy::all)]

pub mod capture;
pub mod cursor;
pub mod engine;
pub mod singular_clock;
pub mod tls;
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
