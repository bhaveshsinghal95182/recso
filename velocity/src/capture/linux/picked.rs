//! A screen or window picked before the recording starts.
//!
//! The recorder's source tile opens the portal's picker as soon as it is
//! clicked, so the user sees what they chose (a thumbnail of its first frame)
//! before pressing record. The portal session stays open, holding the grant,
//! until a recording takes it (`take`) or the recorder lets it go
//! (`release_screen_source`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::Mutex;
use std::time::Duration;

use image::codecs::jpeg::JpegEncoder;
use image::{ExtendedColorType, RgbImage};
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Task};
use napi_derive::napi;

use super::encoder::PixelOrder;
use super::pipewire_stream::{self, Frame, NodeSource};
use super::portal::{self, Grant, PortalRequest, Session, SourceKind};

/// The picked source, waiting for a recording.
static HELD: Mutex<Option<(Grant, Session)>> = Mutex::new(None);
/// One picker at a time: a second click while it is open is refused.
static PICKING: AtomicBool = AtomicBool::new(false);

/// How long to wait for the thumbnail's first frame.
const THUMBNAIL_WAIT: Duration = Duration::from_secs(3);
/// The thumbnail's bounding box.
const THUMBNAIL_SIZE: (u32, u32) = (640, 360);

/// The held source, for a recording that is starting. Leaves nothing held.
pub(crate) fn take() -> Option<(Grant, Session)> {
  HELD.lock().unwrap_or_else(|e| e.into_inner()).take()
}

fn hold(grant: Grant, session: Session) {
  let previous = HELD
    .lock()
    .unwrap_or_else(|e| e.into_inner())
    .replace((grant, session));
  if let Some((_, session)) = previous {
    session.close();
  }
}

/** Linux only: what the user picked in the portal, for the recorder's source tile. */
#[napi(object)]
pub struct PickedScreenSource {
  /** "screen", "window", or "unknown" when the portal does not say. */
  pub kind: String,
  pub width: Option<u32>,
  pub height: Option<u32>,
  /** A JPEG of the source's first frame, when one arrived in time. */
  pub thumbnail_jpeg: Option<Buffer>,
}

pub struct PickScreenSource;

pub struct Picked {
  kind: SourceKind,
  size: Option<(u32, u32)>,
  thumbnail: Option<Vec<u8>>,
}

impl Task for PickScreenSource {
  type Output = Picked;
  type JsValue = PickedScreenSource;

  fn compute(&mut self) -> napi::Result<Picked> {
    if PICKING.swap(true, Ordering::AcqRel) {
      return Err(napi::Error::from_reason("the screen picker is already open"));
    }
    let result = pick();
    PICKING.store(false, Ordering::Release);
    result.map_err(napi::Error::from_reason)
  }

  fn resolve(&mut self, _env: Env, picked: Picked) -> napi::Result<PickedScreenSource> {
    Ok(PickedScreenSource {
      kind: match picked.kind {
        SourceKind::Screen => "screen",
        SourceKind::Window => "window",
        SourceKind::Unknown => "unknown",
      }
      .to_string(),
      width: picked.size.map(|(width, _)| width),
      height: picked.size.map(|(_, height)| height),
      thumbnail_jpeg: picked.thumbnail.map(Buffer::from),
    })
  }
}

fn pick() -> Result<Picked, String> {
  let (mut grant, session) = portal::open(true, PortalRequest::default(), true)?;
  let thumbnail = grant.preview_remote.take().and_then(|remote| {
    thumbnail(NodeSource { remote: Some(remote), node_id: grant.node_id })
      .map_err(|error| eprintln!("[velocity] no thumbnail for the picked source: {error}"))
      .ok()
  });
  let picked = Picked { kind: grant.kind, size: grant.size, thumbnail };
  hold(grant, session);
  Ok(picked)
}

/// Linux only: show the portal's screen and window picker now, and hold the
/// choice for the next recording. Rejects with "screen selection was
/// cancelled" when the user closes the picker.
#[napi]
pub fn pick_screen_source() -> AsyncTask<PickScreenSource> {
  AsyncTask::new(PickScreenSource)
}

/// Linux only: let go of a picked source that no recording took.
#[napi]
pub fn release_screen_source() {
  if let Some((_, session)) = take() {
    session.close();
  }
}

/// The first frame from the node, as a small JPEG.
fn thumbnail(source: NodeSource) -> Result<Vec<u8>, String> {
  let (tx, rx) = sync_channel::<RgbImage>(1);
  let stream = pipewire_stream::start(source, 5, None, move |frame: Frame<'_>| {
    if let Some(image) = to_rgb(&frame) {
      let _ = tx.try_send(image);
    }
  })?;
  let first = rx.recv_timeout(THUMBNAIL_WAIT);
  let _ = stream.stop();
  let image = first.map_err(|_| "no frame arrived".to_string())?;
  let (width, height) = fit(image.width(), image.height(), THUMBNAIL_SIZE);
  let small = image::imageops::thumbnail(&image, width, height);
  let mut jpeg = Vec::new();
  JpegEncoder::new_with_quality(&mut jpeg, 80)
    .encode(small.as_raw(), width, height, ExtendedColorType::Rgb8)
    .map_err(|error| format!("encode the thumbnail: {error}"))?;
  Ok(jpeg)
}

fn to_rgb(frame: &Frame<'_>) -> Option<RgbImage> {
  let (width, height) = (frame.width as usize, frame.height as usize);
  if width == 0 || height == 0 || frame.stride < width * 4 {
    return None;
  }
  let mut rgb = Vec::with_capacity(width * height * 3);
  for row in frame.pixels.chunks(frame.stride).take(height) {
    for pixel in row.get(..width * 4)?.chunks_exact(4) {
      match frame.order {
        PixelOrder::Bgrx => rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]),
        PixelOrder::Rgbx => rgb.extend_from_slice(&pixel[..3]),
      }
    }
  }
  RgbImage::from_raw(frame.width, frame.height, rgb)
}

/// Scale `(width, height)` to fit `bounds`, keeping the aspect ratio and
/// never enlarging.
fn fit(width: u32, height: u32, bounds: (u32, u32)) -> (u32, u32) {
  let scale = (bounds.0 as f64 / width as f64)
    .min(bounds.1 as f64 / height as f64)
    .min(1.0);
  (
    ((width as f64 * scale).round() as u32).max(1),
    ((height as f64 * scale).round() as u32).max(1),
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::Instant;

  #[test]
  fn thumbnails_fit_the_box_without_enlarging() {
    assert_eq!(fit(3840, 2160, THUMBNAIL_SIZE), (640, 360));
    assert_eq!(fit(1080, 1920, THUMBNAIL_SIZE), (203, 360));
    assert_eq!(fit(320, 200, THUMBNAIL_SIZE), (320, 200));
  }

  #[test]
  fn frames_convert_to_rgb_in_either_order_and_skip_row_padding() {
    // 2x2, stride 12 (4 bytes of padding per row).
    let pixels = [
      1, 2, 3, 0, 4, 5, 6, 0, 9, 9, 9, 9, //
      7, 8, 9, 0, 10, 11, 12, 0, 9, 9, 9, 9,
    ];
    let frame = |order| Frame {
      pixels: &pixels,
      width: 2,
      height: 2,
      stride: 12,
      order,
      received: Instant::now(),
    };
    assert_eq!(
      to_rgb(&frame(PixelOrder::Rgbx)).unwrap().into_raw(),
      vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    );
    assert_eq!(
      to_rgb(&frame(PixelOrder::Bgrx)).unwrap().into_raw(),
      vec![3, 2, 1, 6, 5, 4, 9, 8, 7, 12, 11, 10]
    );
  }
}
