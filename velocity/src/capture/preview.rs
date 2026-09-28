//! The latest webcam preview frame, polled by the recorder UI.
//!
//! A single slot rather than a queue: the UI only ever wants the newest frame.

use std::sync::atomic::AtomicU32;
use std::sync::{Mutex, OnceLock};

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/** A small JPEG copied from the native camera owner for the recorder UI. */
#[napi(object)]
pub struct WebcamPreviewFrame {
  pub jpeg: Buffer,
  pub width: u32,
  pub height: u32,
  /** Monotonic, so a polling renderer can skip a frame it has already drawn. */
  pub sequence: u32,
}

pub(crate) struct StoredWebcamPreviewFrame {
  pub(crate) jpeg: Vec<u8>,
  pub(crate) width: u32,
  pub(crate) height: u32,
  pub(crate) sequence: u32,
}

static WEBCAM_PREVIEW_FRAME: OnceLock<Mutex<Option<StoredWebcamPreviewFrame>>> = OnceLock::new();
pub(crate) static WEBCAM_PREVIEW_SEQUENCE: AtomicU32 = AtomicU32::new(0);

pub(crate) fn preview_frame_slot() -> &'static Mutex<Option<StoredWebcamPreviewFrame>> {
  WEBCAM_PREVIEW_FRAME.get_or_init(|| Mutex::new(None))
}

#[napi]
pub fn webcam_preview_frame() -> Option<WebcamPreviewFrame> {
  let slot = preview_frame_slot().lock().ok()?;
  let frame = slot.as_ref()?;

  Some(WebcamPreviewFrame {
    jpeg: frame.jpeg.clone().into(),
    width: frame.width,
    height: frame.height,
    sequence: frame.sequence,
  })
}

#[napi]
pub fn clear_webcam_preview_frame() {
  if let Ok(mut slot) = preview_frame_slot().lock() {
    *slot = None;
  }
}
