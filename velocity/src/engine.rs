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
mod composite;
#[cfg(windows)]
mod cuts;
#[cfg(windows)]
mod d3d;
#[cfg(windows)]
mod decode;
#[cfg(windows)]
mod encode;
#[cfg(windows)]
mod exporter;
#[cfg(windows)]
mod mf;
#[cfg(windows)]
mod pattern;
#[cfg(windows)]
mod player;
#[cfg(windows)]
mod render;
#[cfg(windows)]
pub mod zoom;
