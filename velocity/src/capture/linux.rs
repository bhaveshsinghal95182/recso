//! The Linux capture backend.
//!
//! The xdg-desktop-portal grants a PipeWire stream of the screen or window the
//! user picked; frames from it are encoded to H.264 with openh264 and muxed to
//! MP4. Every piece is permissively licensed, as the product requires.

pub(crate) mod audio;
pub(crate) mod encoder;
pub(crate) mod pipewire_stream;
pub(crate) mod portal;
pub(crate) mod screen;
