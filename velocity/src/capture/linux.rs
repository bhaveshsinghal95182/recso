//! The Linux capture backend.
//!
//! The xdg-desktop-portal grants a PipeWire stream of the screen or window the
//! user picked; frames from it are encoded to H.264 with openh264 and muxed to
//! MP4. Every piece is permissively licensed, as the product requires.

pub(crate) mod audio;
pub(crate) mod cursor_meta;
pub(crate) mod encoder;
pub(crate) mod input_clicks;
pub(crate) mod mp4_writer;
pub(crate) mod nvenc;
mod nvenc_sys;
pub(crate) mod picked;
pub(crate) mod pipewire_stream;
pub(crate) mod portal;
pub(crate) mod screen;
pub(crate) mod webcam;

use super::devices::AudioDeviceInfo;

/// The microphones PipeWire knows about, for the recorder's picker. Each id
/// is a PipeWire node id, which is what a recording's `microphoneDeviceId`
/// takes back.
#[napi_derive::napi]
pub fn list_audio_capture_devices() -> Vec<AudioDeviceInfo> {
  audio::list_audio_capture_devices()
}
