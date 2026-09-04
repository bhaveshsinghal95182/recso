//! A camera that arrives over the network instead of over USB.
//!
//! The phone opens a page served by the desktop app, captures its own camera,
//! and posts JPEG frames back. They land here, get decoded, and sit in a single
//! slot that the webcam sidecar loop reads exactly the way it reads a local
//! camera.
//!
//! That indifference is the whole design. The sidecar loop already drives its
//! own clock -- it writes a frame every period whether or not a new one turned
//! up, holding the last -- which is precisely what a camera on the far side of a
//! wifi link needs. So a phone is not a second recording path; it is a different
//! source for the one that exists, and it inherits the screen recording's
//! timeline rather than having to be aligned to it afterwards.
//!
//! One slot, not a queue. A frame that arrived while the encoder was busy with
//! the previous one is already out of date, and a queue would spend the rest of
//! the recording playing catch-up -- the sidecar's timestamps advance on the
//! clock, so late frames do not get their own moment, they get somebody else's.
//! Dropping them keeps the picture live.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use image::ImageFormat;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use super::webcam_capture::rgb_to_bgra_bottom_up;

/// How long a frame stays believable.
///
/// Past this the phone has stopped sending -- backgrounded, out of range, or
/// the browser tab closed. The loop keeps writing the last frame anyway, since
/// a hole in the sidecar is worse than a still one, but the desktop wants to
/// know so it can say something rather than letting the user record ten minutes
/// against a frozen picture.
const FRAME_FRESH_FOR: Duration = Duration::from_millis(1500);

/// The newest frame the phone sent, already in the form the encoder wants.
struct PhoneFrame {
  /// Bottom-up BGRA, matching what the local camera path produces.
  bgra: Vec<u8>,
  width: usize,
  height: usize,
}

static SLOT: Mutex<Option<PhoneFrame>> = Mutex::new(None);

/// What the last frame was and when it turned up, kept separately from the slot.
///
/// The slot empties as soon as the recorder reads it, so it answers "is there an
/// unread frame", which is a different question from "is the phone still
/// sending". While a recording is running the slot is empty most of the time --
/// that is the loop working correctly -- and reading liveness off it would make
/// the panel say the phone had stopped and the recorder refuse to start against
/// a phone that was streaming perfectly well.
struct LastSeen {
  at: Instant,
  width: usize,
  height: usize,
}

static LAST_SEEN: Mutex<Option<LastSeen>> = Mutex::new(None);

/// Bumped on every accepted frame, so a reader can tell a new one from the one
/// it already wrote without comparing pixels.
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Frames the phone sent that were never written, because a newer one arrived
/// first. Reported rather than hidden: a large number means the link cannot
/// keep up with the rate the phone was asked for.
static DROPPED: AtomicU64 = AtomicU64::new(0);

/// Decode a JPEG into the slot, replacing whatever was there.
///
/// Split out from the napi entry point so the work happens off the JavaScript
/// thread -- a 720p JPEG costs a few milliseconds, and thirty of those a second
/// is a meaningful share of an event loop that also has a recording UI on it.
fn accept(jpeg: &[u8]) -> std::result::Result<(u32, u32), String> {
  let decoded = image::load_from_memory_with_format(jpeg, ImageFormat::Jpeg)
    .map_err(|error| format!("could not decode the frame: {error}"))?;

  let rgb = decoded.to_rgb8();
  let width = rgb.width() as usize;
  let height = rgb.height() as usize;
  if width == 0 || height == 0 {
    return Err("the frame had no pixels".to_string());
  }

  let bgra = rgb_to_bgra_bottom_up(rgb.as_raw(), width, height);

  let mut slot = SLOT.lock().map_err(|_| "frame slot poisoned".to_string())?;
  if slot.is_some() {
    // Replacing an unread frame. Not an error -- see the note at the top about
    // why this is a slot and not a queue -- but worth counting.
    DROPPED.fetch_add(1, Ordering::Relaxed);
  }

  *slot = Some(PhoneFrame {
    bgra,
    width,
    height,
  });
  drop(slot);

  if let Ok(mut seen) = LAST_SEEN.lock() {
    *seen = Some(LastSeen {
      at: Instant::now(),
      width,
      height,
    });
  }
  SEQUENCE.fetch_add(1, Ordering::Release);

  Ok((width as u32, height as u32))
}

/// The newest frame, if one has arrived since the caller last asked.
///
/// Takes it rather than cloning: the sidecar loop keeps its own copy of the
/// last frame to hold, so leaving it here would only mean carrying two.
pub(crate) fn take_frame() -> Option<(Vec<u8>, usize, usize)> {
  let mut slot = SLOT.lock().ok()?;
  slot
    .take()
    .map(|frame| (frame.bgra, frame.width, frame.height))
}

/// Whether the phone has sent anything recently enough to trust.
///
/// Asked of the last arrival rather than the slot, which is usually empty while
/// a recording is draining it.
pub(crate) fn is_live() -> bool {
  LAST_SEEN
    .lock()
    .ok()
    .and_then(|seen| seen.as_ref().map(|seen| seen.at.elapsed()))
    .map(|age| age < FRAME_FRESH_FOR)
    .unwrap_or(false)
}

/// Forget any frame still sitting in the slot.
///
/// Called when a session starts, so a recording cannot open on a frame from a
/// pairing session the user abandoned ten minutes ago.
#[napi]
pub fn reset_phone_camera() {
  if let Ok(mut slot) = SLOT.lock() {
    *slot = None;
  }
  if let Ok(mut seen) = LAST_SEEN.lock() {
    *seen = None;
  }
  DROPPED.store(0, Ordering::Relaxed);
}

/// What the phone link is doing, for the UI to report.
#[napi(object)]
pub struct PhoneCameraStatus {
  /// Frames accepted since the process started.
  pub frames_received: f64,
  /// Frames replaced before anything read them. A steady climb means the link
  /// is delivering faster than the sidecar is consuming, which is harmless; a
  /// climb alongside a low frame rate means the phone is struggling.
  pub frames_dropped: f64,
  /// Whether a frame has arrived recently enough to still be showing the room.
  pub live: bool,
  /// Size of the last frame, or 0 before the first one.
  pub width: u32,
  pub height: u32,
}

#[napi]
pub fn phone_camera_status() -> PhoneCameraStatus {
  let (live, width, height) = LAST_SEEN
    .lock()
    .ok()
    .map(|seen| match seen.as_ref() {
      Some(seen) => (
        seen.at.elapsed() < FRAME_FRESH_FOR,
        seen.width as u32,
        seen.height as u32,
      ),
      None => (false, 0, 0),
    })
    .unwrap_or((false, 0, 0));

  PhoneCameraStatus {
    frames_received: SEQUENCE.load(Ordering::Acquire) as f64,
    frames_dropped: DROPPED.load(Ordering::Relaxed) as f64,
    live,
    width,
    height,
  }
}

/// The decode, as something napi can run off-thread.
pub struct DecodeFrame {
  jpeg: Vec<u8>,
}

impl Task for DecodeFrame {
  type Output = (u32, u32);
  type JsValue = PhoneFrameAccepted;

  fn compute(&mut self) -> Result<Self::Output> {
    accept(&self.jpeg).map_err(Error::from_reason)
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(PhoneFrameAccepted {
      width: output.0,
      height: output.1,
    })
  }
}

#[napi(object)]
pub struct PhoneFrameAccepted {
  pub width: u32,
  pub height: u32,
}

/// Hand one JPEG frame from the phone to the recorder.
///
/// Returns a promise because the decode runs on the worker pool. Awaiting it is
/// optional and mostly useful for backpressure: a caller that stops awaiting
/// will simply queue decodes faster than they finish, and the slot will discard
/// all but the newest anyway.
#[napi]
pub fn push_phone_frame(jpeg: Buffer) -> AsyncTask<DecodeFrame> {
  AsyncTask::new(DecodeFrame {
    jpeg: jpeg.to_vec(),
  })
}
