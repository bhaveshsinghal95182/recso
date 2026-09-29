//! Software video tools for Linux recordings.
//!
//! Decode and timeline artwork share the same MP4 source, while the napi
//! boundary only translates their results into the existing JavaScript shapes.

mod api;
mod media;
mod thumbnails;

pub(crate) mod render;
pub(crate) mod player;
pub(crate) mod present;
