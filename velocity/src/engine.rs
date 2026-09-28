//! GPU-resident video pipeline: decode, grade, present, encode.
//!
//! One path, end to end, with the pixels never leaving the GPU:
//!
//!   file -> Media Foundation hardware decode -> D3D11 texture
//!        -> render chain (NV12 -> BGRA, effects)
//!        -> shared NT handle -> Electron importSharedTexture -> canvas
//!                            \
//!                             -> NV12 -> hardware encoder -> MP4
//!
//! The render chain sits *before* that fork on purpose. A filter cannot look
//! one way on screen and another way in the exported file, because there is
//! only one implementation and both consumers pull from it.
//!
//! This runs alongside recso's existing `<video>` + Pixi preview rather than
//! replacing it. See `docs/ENGINE.md` for how the two paths relate and what
//! has to be true before the old one goes away.
//!
//! Windows only. Everything below is `#[cfg(windows)]`, and the crate builds
//! without it on other platforms so `cargo check` stays useful there.

#[cfg(windows)]
pub mod api;
#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod composite;
mod cuts;
#[cfg(windows)]
mod d3d;
#[cfg(windows)]
mod decode;
#[cfg(windows)]
mod encode;
#[cfg(windows)]
mod exporter;
mod layout;
#[cfg(windows)]
mod mf;
mod pattern;
#[cfg(windows)]
mod player;
#[cfg(windows)]
mod render;
mod scene;
#[cfg(windows)]
mod spritesheet;
pub mod zoom;

/// Cross-module scenarios: the tracks composed the way the render chain
/// composes them, rather than one at a time.
///
/// The per-module tests pin each timeline on its own. These pin the seams --
/// above all which clock each one is expressed in, which is the mistake that
/// does not crash and does not show up until someone watches the frame after a
/// cut.
#[cfg(test)]
mod scenarios;

/// Combination matrices: the same functions swept across the cross-product of
/// the inputs they actually see, asserting the invariants that must hold for
/// every cell rather than the value of any one of them.
#[cfg(test)]
mod matrix;

/// Generated editing sessions.
///
/// Rather than a handful of hand-written projects, this builds a few hundred
/// from a deterministic pseudo-random generator and asserts the invariants
/// that have to hold for every one of them. Hand-picked cases test the shapes
/// somebody thought of; these test the shapes nobody did.
#[cfg(test)]
mod sessions;

/// Regressions in this module's own code. See `crate::regressions` for the
/// ones whose subject is reachable from the crate root.
#[cfg(test)]
mod regressions;
