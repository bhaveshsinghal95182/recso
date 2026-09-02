//! A real player, as opposed to the prototype's decode-one-frame-on-demand.
//!
//! Four things the prototype cheated on, fixed here:
//!
//! 1. **Texture pool.** One shared texture meant a decode could overwrite a
//!    frame the GPU process was still reading. Frames now round-robin through a
//!    pool big enough that the queue can never lap it.
//! 2. **Off the JS thread.** Decoding runs on its own thread and reads ahead
//!    into a bounded queue, so a slow frame does not stall the UI.
//! 3. **A clock.** The engine owns playback time. `tick` hands back the frame
//!    that is due now, which makes frame pacing and dropping fall out naturally.
//! 4. **Frame-accurate seek.** Media Foundation only seeks to a keyframe; we
//!    decode forward from there to the frame that actually covers the target.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::Result;
use windows::Win32::Graphics::Direct3D11::ID3D11RenderTargetView;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

use crate::engine::d3d::{gpu, SharedTexture, Sharing};
use crate::engine::decode::Decoder;
use crate::engine::composite::{CursorSample, CursorTrack, SpriteTexture, WebcamLayout};
use crate::engine::render::{create_rtv, EffectParams, RenderChain};

/// How far ahead of the playhead we decode.
///
/// Deep enough to ride out a slow frame, shallow enough that a seek does not
/// throw away much work.
const QUEUE_CAPACITY: usize = 12;

/// Pool slack beyond the queue: one for the frame currently on screen, plus
/// headroom for frames still in flight to the GPU process. Without this the
/// producer laps the queue and overwrites a frame someone is reading.
const POOL_SLACK: usize = 6;

/// Cap on how far a frame-accurate seek will decode forward, so a file with a
/// pathological GOP cannot hang the decode thread.
const MAX_SEEK_DECODE: usize = 600;

#[derive(Clone, Copy)]
pub struct QueuedFrame {
  /// Which pool slot holds this frame, in both its rendered BGRA form and its
  /// decoded NV12 source. Needed so a filter change can re-render it.
  pub slot: usize,
  pub pts_ms: f64,
  pub handle_bits: u64,
  pub coded_width: u32,
  pub coded_height: u32,
  pub visible_width: u32,
  pub visible_height: u32,
  /// Bumped on every seek, and on any effect change, so frames rendered under
  /// the old settings are discarded rather than briefly shown.
  pub generation: u64,
}

/// Maps wall-clock time onto media time.
struct Clock {
  playing: bool,
  rate: f64,
  anchor_media_ms: f64,
  anchor_at: Instant,
  /// The clock is free-running against the wall clock, so without this it
  /// keeps counting forever once playback passes the end of the file.
  duration_ms: f64,
}

impl Clock {
  fn now_ms(&self) -> f64 {
    let raw = if self.playing {
      self.anchor_media_ms + self.anchor_at.elapsed().as_secs_f64() * 1000.0 * self.rate
    } else {
      self.anchor_media_ms
    };
    raw.clamp(0.0, self.duration_ms.max(0.0))
  }

  /// Re-anchor before changing anything, or the time elapsed since the last
  /// anchor gets applied at the wrong rate or play state.
  fn reanchor(&mut self) {
    self.anchor_media_ms = self.now_ms();
    self.anchor_at = Instant::now();
  }

  fn set_playing(&mut self, playing: bool) {
    self.reanchor();
    self.playing = playing;
  }

  fn set_rate(&mut self, rate: f64) {
    self.reanchor();
    self.rate = rate.clamp(0.1, 8.0);
  }

  fn jump_to(&mut self, ms: f64) {
    self.anchor_media_ms = ms;
    self.anchor_at = Instant::now();
  }
}

pub struct Shared {
  frames: Mutex<VecDeque<QueuedFrame>>,
  /// Notified when the consumer pops, so the producer can refill.
  space: Condvar,
  clock: Mutex<Clock>,
  generation: AtomicU64,
  running: AtomicBool,
  eof: AtomicBool,
  /// Whether a camera sidecar opened. False when there was none, and also when
  /// one was named but could not be decoded.
  has_webcam: AtomicBool,
  /// Pointer samples currently loaded, published once the decode thread has
  /// taken the track on.
  cursor_samples: AtomicU64,
  /// Present the next available frame regardless of the clock. Set after a
  /// seek and at startup, so a paused player still shows where it landed.
  force_present: AtomicBool,
  /// The frame currently on screen. Kept so a filter change can re-render and
  /// re-present it, which is what makes grading while paused feel live.
  current: Mutex<Option<QueuedFrame>>,
  /// Hand the current frame back once more, because its pixels changed under
  /// it. Re-queueing instead would bypass the queue's backpressure and pile up
  /// duplicates during a slider drag.
  repaint: AtomicBool,

  pub duration_ms: f64,
  pub width: u32,
  pub height: u32,
  pub coded_width: u32,
  pub coded_height: u32,
  pub fps_num: u32,
  pub fps_den: u32,
  /// Every NT handle in the pool.
  ///
  /// The GPU process pays a one-time import cost per handle (~450ms total for
  /// 18 slots at 1080p). Exposing them lets the app pay that at open time
  /// instead of discovering it as a stall during the first second of playback.
  pub pool_handles: Vec<u64>,

  decoded: AtomicU64,
  dropped: AtomicU64,
  /// Samples the decoder returned with no texture attached.
  skipped_no_texture: AtomicU64,
  /// Frames the render layer refused.
  skipped_render_error: AtomicU64,
  /// Worst time `tick` spent waiting on the frame queue mutex. Separates
  /// contention from work done inside tick itself.
  max_queue_wait_us: AtomicU64,
  decode_us_total: AtomicU64,
  last_seek_us: AtomicU64,
  /// Frames the last seek had to decode forward. This is the GOP cost, made
  /// visible so a slow scrub has an obvious explanation.
  last_seek_decoded: AtomicU64,
}

/// Exact seeks cost a full GOP of decode, which is fine for a click and far too
/// slow while dragging a scrubber. Fast seeks stop at the keyframe.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SeekMode {
  /// Nearest preceding keyframe. Cheap, can be off by most of a GOP.
  Fast,
  /// The frame that actually covers the target time.
  Exact,
}

/// A cursor bitmap on its way to the decode thread.
///
/// Carried as raw pixels rather than a texture because the D3D resource is
/// created on the decode thread, which is the only one that touches the chain.
pub struct CursorImage {
  pub width: u32,
  pub height: u32,
  pub pixels: Vec<u8>,
  pub hotspot_x: f32,
  pub hotspot_y: f32,
}

enum Command {
  Seek(f64, SeekMode),
  SetEffects(EffectParams),
  SetWebcamLayout(WebcamLayout),
  SetCursorImage(Option<CursorImage>),
  SetCursorTrack(Vec<CursorSample>),
  SetCursorStyle(f32, f32),
  /// Read the composited frame currently on screen back to system memory.
  ///
  /// Serviced on the decode thread because it owns the pool. Replying through a
  /// channel keeps the caller blocked only as long as the copy takes.
  Snapshot(std::sync::mpsc::SyncSender<Option<Vec<u8>>>),
  Stop,
}

pub struct Player {
  shared: Arc<Shared>,
  tx: Sender<Command>,
  thread: Option<JoinHandle<()>>,
}

pub struct Stats {
  pub queue_depth: u32,
  pub decoded: u64,
  pub dropped: u64,
  pub skipped_no_texture: u64,
  pub skipped_render_error: u64,
  pub max_queue_wait_us: u64,
  pub avg_decode_ms: f64,
  pub last_seek_ms: f64,
  pub last_seek_decoded: u32,
  pub end_of_stream: bool,
  pub playing: bool,
  pub current_time_ms: f64,
  pub rate: f64,
}

impl Player {
  pub fn open(path: &str) -> Result<Self> {
    Self::open_with_webcam(path, None)
  }

  /// Open a screen recording, optionally with its camera sidecar.
  ///
  /// The webcam is a second decoder on the same thread rather than a second
  /// player. Two players would each own a clock and the two would drift; here
  /// there is one clock, and the camera is pulled to whatever timestamp the
  /// screen frame has.
  ///
  /// A webcam that fails to open is not fatal -- the recording is still
  /// editable without its overlay, and refusing to open at all would be a worse
  /// outcome than a missing camera.
  pub fn open_with_webcam(path: &str, webcam_path: Option<&str>) -> Result<Self> {
    let decoder = Decoder::open(path)?;
    let webcam = webcam_path.and_then(|webcam_path| match Decoder::open(webcam_path) {
      Ok(decoder) => Some(decoder),
      Err(error) => {
        eprintln!("[engine] webcam sidecar {webcam_path} did not open: {error:?}");
        None
      }
    });
    let gpu = gpu()?;

    let (width, height) = (decoder.display_width, decoder.display_height);
    let (coded_width, coded_height) = decoder.coded_size();

    // The pool holds the render layer's *output*, not decoder output, so it is
    // BGRA now. Electron requires bgra handles to carry no keyed mutex, which
    // is the opposite of the nv12 rule and also removes the acquire/release on
    // every frame.
    let mut pool = Vec::with_capacity(QUEUE_CAPACITY + POOL_SLACK);
    let mut pool_rtvs = Vec::with_capacity(QUEUE_CAPACITY + POOL_SLACK);
    for _ in 0..QUEUE_CAPACITY + POOL_SLACK {
      let texture = SharedTexture::new(
        gpu,
        coded_width,
        coded_height,
        DXGI_FORMAT_B8G8R8A8_UNORM,
        Sharing::Plain,
        None,
      )?;
      pool_rtvs.push(create_rtv(gpu, &texture.texture)?);
      pool.push(texture);
    }

    let pool_handles = pool.iter().map(|t| t.handle_bits()).collect();

    let shared = Arc::new(Shared {
      frames: Mutex::new(VecDeque::with_capacity(QUEUE_CAPACITY)),
      space: Condvar::new(),
      clock: Mutex::new(Clock {
        playing: false,
        rate: 1.0,
        anchor_media_ms: 0.0,
        anchor_at: Instant::now(),
        duration_ms: decoder.duration_100ns as f64 / 10_000.0,
      }),
      generation: AtomicU64::new(0),
      running: AtomicBool::new(true),
      eof: AtomicBool::new(false),
      // Show the first frame as soon as one exists, without pressing play.
      force_present: AtomicBool::new(true),
      // Reported rather than inferred from the path: a sidecar that fails to
      // open leaves the player usable, and the caller needs to know the overlay
      // will not appear.
      has_webcam: AtomicBool::new(webcam.is_some()),
      cursor_samples: AtomicU64::new(0),
      current: Mutex::new(None),
      repaint: AtomicBool::new(false),
      duration_ms: decoder.duration_100ns as f64 / 10_000.0,
      width,
      height,
      coded_width,
      coded_height,
      fps_num: decoder.fps_num,
      fps_den: decoder.fps_den,
      pool_handles,
      decoded: AtomicU64::new(0),
      dropped: AtomicU64::new(0),
      skipped_no_texture: AtomicU64::new(0),
      skipped_render_error: AtomicU64::new(0),
      max_queue_wait_us: AtomicU64::new(0),
      decode_us_total: AtomicU64::new(0),
      last_seek_us: AtomicU64::new(0),
      last_seek_decoded: AtomicU64::new(0),
    });

    // The chain lives on the decode thread: it drives the immediate context,
    // and only one thread should be issuing a pass sequence at a time. It keeps
    // one NV12 source per pool slot so any frame still in flight can be
    // re-rendered without decoding it again.
    let mut chain = RenderChain::new(coded_width, coded_height, pool.len())?;

    if let Some(webcam) = webcam.as_ref() {
      // Its own resolution, not the canvas's -- the camera is composited as a
      // quad, so it converts at native size and is scaled by the draw.
      let (webcam_width, webcam_height) = webcam.coded_size();
      chain.attach_webcam(webcam_width, webcam_height)?;
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let thread_shared = Arc::clone(&shared);
    let thread = std::thread::Builder::new()
      .name("decode".into())
      .spawn(move || decode_loop(thread_shared, rx, decoder, webcam, pool, pool_rtvs, chain))
      .expect("spawn decode thread");

    Ok(Self {
      shared,
      tx,
      thread: Some(thread),
    })
  }

  pub fn shared(&self) -> &Shared {
    &self.shared
  }

  /// Start or stop playback.
  ///
  /// Pressing play at the end restarts, which is what every player does and
  /// what the alternative -- appearing to do nothing -- is not.
  pub fn set_playing(&self, playing: bool) {
    if playing && self.at_end() {
      self.seek(0.0, SeekMode::Exact);
    }
    self.shared.clock.lock().unwrap().set_playing(playing);
  }

  /// True once the decoder is finished and every decoded frame has been shown.
  fn at_end(&self) -> bool {
    self.shared.eof.load(Ordering::Acquire) && self.shared.frames.lock().unwrap().is_empty()
  }

  pub fn set_rate(&self, rate: f64) {
    self.shared.clock.lock().unwrap().set_rate(rate);
  }

  /// Change the effect settings.
  ///
  /// Deliberately does *not* bump the generation or seek. Every frame the
  /// player is holding still has its decoded NV12 source, so the decode thread
  /// re-renders them in place. Discarding and re-decoding instead cost a full
  /// exact seek per slider event, which is why grading used to lag.
  pub fn set_effects(&self, params: EffectParams) {
    let _ = self.tx.send(Command::SetEffects(params));
    self.shared.space.notify_all();
  }

  /// Move or reshape the webcam box.
  ///
  /// Same mechanism as grading, and for the same reason: the frames already
  /// queued get re-rendered in place rather than re-decoded, so dragging the
  /// overlay around stays responsive on long-GOP content.
  /// Whether a camera track was opened alongside the screen recording.
  pub fn has_webcam(&self) -> bool {
    self.shared.has_webcam.load(Ordering::Acquire)
  }

  /// The composited frame currently on screen, as BGRA bytes.
  ///
  /// Everything the render layer does is in here -- grading, the webcam box, the
  /// cursor -- because it reads back the finished pool slot rather than any
  /// intermediate. Returns `None` when nothing has been presented yet.
  ///
  /// Stalls the GPU. For stills and verification, not for playback.
  pub fn snapshot_bgra(&self) -> Option<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    self.tx.send(Command::Snapshot(tx)).ok()?;
    self.shared.space.notify_all();
    rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
  }

  /// How many pointer samples the decode thread has actually taken on.
  ///
  /// The track crosses a channel, so a caller that sets it and immediately
  /// reads back zero has not lost it -- it just has not been applied yet. Worth
  /// having because a silently empty track and a cursor that is merely
  /// offscreen look identical.
  pub fn cursor_sample_count(&self) -> u64 {
    self.shared.cursor_samples.load(Ordering::Acquire)
  }

  pub fn set_webcam_layout(&self, layout: WebcamLayout) {
    let _ = self.tx.send(Command::SetWebcamLayout(layout));
    self.shared.space.notify_all();
  }

  pub fn set_cursor_image(&self, image: Option<CursorImage>) {
    let _ = self.tx.send(Command::SetCursorImage(image));
    self.shared.space.notify_all();
  }

  pub fn set_cursor_track(&self, samples: Vec<CursorSample>) {
    let _ = self.tx.send(Command::SetCursorTrack(samples));
    self.shared.space.notify_all();
  }

  pub fn set_cursor_style(&self, size: f32, opacity: f32) {
    let _ = self.tx.send(Command::SetCursorStyle(size, opacity));
    self.shared.space.notify_all();
  }

  pub fn seek(&self, ms: f64, mode: SeekMode) {
    let clamped = ms.clamp(0.0, self.shared.duration_ms.max(0.0));
    // Bump here rather than on the decode thread, so any frame queued between
    // now and the thread noticing is already stale and gets dropped by `tick`.
    self.shared.generation.fetch_add(1, Ordering::AcqRel);
    self.shared.force_present.store(true, Ordering::Release);
    self.shared.clock.lock().unwrap().jump_to(clamped);
    let _ = self.tx.send(Command::Seek(clamped, mode));
    // Unblock the producer if it is sitting on a full queue.
    self.shared.space.notify_all();
  }

  /// The frame that should be on screen now, or `None` if nothing is due.
  ///
  /// Anything already overdue behind it is discarded and counted as a drop,
  /// which is what keeps playback from drifting when decode falls behind.
  pub fn tick(&self) -> Option<QueuedFrame> {
    let now = self.shared.clock.lock().unwrap().now_ms();
    let generation = self.shared.generation.load(Ordering::Acquire);
    let force = self.shared.force_present.load(Ordering::Acquire);

    let waited = Instant::now();
    let mut queue = self.shared.frames.lock().unwrap();
    let waited_us = waited.elapsed().as_micros() as u64;
    self
      .shared
      .max_queue_wait_us
      .fetch_max(waited_us, Ordering::Relaxed);

    while queue.front().is_some_and(|f| f.generation < generation) {
      queue.pop_front();
    }

    // Some containers report a duration slightly shorter than the last frame's
    // timestamp -- Big Buck Bunny says 10000ms but its final frame is at
    // 10033.3ms. The clock is clamped to the reported duration, so those frames
    // could never come due: the queue would sit at one entry forever and
    // playback would stall a frame short of the end. Once the decoder is
    // finished and the clock has reached its ceiling, drain whatever is left.
    let draining = self.shared.eof.load(Ordering::Acquire)
      && now >= self.shared.duration_ms - 0.001;

    let mut chosen: Option<QueuedFrame> = None;
    while let Some(&front) = queue.front() {
      if !force && !draining && front.pts_ms > now {
        break;
      }
      queue.pop_front();
      if chosen.is_some() {
        self.shared.dropped.fetch_add(1, Ordering::Relaxed);
      }
      chosen = Some(front);
      if force {
        break;
      }
    }

    if let Some(frame) = chosen {
      self.shared.force_present.store(false, Ordering::Release);
      *self.shared.current.lock().unwrap() = Some(frame);
      self.shared.space.notify_all();
    } else if self.shared.repaint.swap(false, Ordering::AcqRel) {
      // Nothing new is due, but the frame on screen was re-rendered in place.
      // Same slot, same handle -- only the pixels behind it changed.
      chosen = *self.shared.current.lock().unwrap();
    }

    // Stop cleanly at the end instead of letting the clock run past the last
    // frame. `eof` alone is not enough: the decoder finishes well before the
    // queue drains, and pausing then would cut playback short.
    if queue.is_empty() && self.shared.eof.load(Ordering::Acquire) {
      let mut clock = self.shared.clock.lock().unwrap();
      if clock.playing {
        clock.playing = false;
        let end = clock.duration_ms;
        clock.jump_to(end);
      }
    }

    chosen
  }

  pub fn stats(&self) -> Stats {
    let clock = self.shared.clock.lock().unwrap();
    let decoded = self.shared.decoded.load(Ordering::Relaxed);
    let total_us = self.shared.decode_us_total.load(Ordering::Relaxed);

    Stats {
      queue_depth: self.shared.frames.lock().unwrap().len() as u32,
      decoded,
      dropped: self.shared.dropped.load(Ordering::Relaxed),
      skipped_no_texture: self.shared.skipped_no_texture.load(Ordering::Relaxed),
      skipped_render_error: self.shared.skipped_render_error.load(Ordering::Relaxed),
      max_queue_wait_us: self.shared.max_queue_wait_us.load(Ordering::Relaxed),
      avg_decode_ms: if decoded == 0 {
        0.0
      } else {
        total_us as f64 / decoded as f64 / 1000.0
      },
      last_seek_ms: self.shared.last_seek_us.load(Ordering::Relaxed) as f64 / 1000.0,
      last_seek_decoded: self.shared.last_seek_decoded.load(Ordering::Relaxed) as u32,
      end_of_stream: self.shared.eof.load(Ordering::Acquire),
      playing: clock.playing,
      current_time_ms: clock.now_ms(),
      rate: clock.rate,
    }
  }

  pub fn close(&mut self) {
    self.shared.running.store(false, Ordering::Release);
    let _ = self.tx.send(Command::Stop);
    self.shared.space.notify_all();
    if let Some(t) = self.thread.take() {
      let _ = t.join();
    }
  }
}

impl Drop for Player {
  fn drop(&mut self) {
    self.close();
  }
}

fn make_frame(shared: &Shared, slot_index: usize, slot: &SharedTexture, pts_ms: f64) -> QueuedFrame {
  QueuedFrame {
    slot: slot_index,
    pts_ms,
    handle_bits: slot.handle_bits(),
    coded_width: shared.coded_width,
    coded_height: shared.coded_height,
    visible_width: shared.width,
    visible_height: shared.height,
    generation: shared.generation.load(Ordering::Acquire),
  }
}

/// Where the webcam decoder has got to relative to the screen recording.
///
/// The camera runs at its own rate and screen capture only produces a frame
/// when something changes, so the two streams do not line up and the ratio is
/// not even constant. This tracks the one frame we have read but not yet
/// reached, so it is not decoded twice.
#[derive(Default)]
struct WebcamSync {
  /// Timestamp of the most recently read camera frame, when it is ahead of the
  /// screen frame being composed.
  ahead_ms: Option<f64>,
}

/// Bring the webcam layer up to `target_ms` for `slot`.
///
/// Inherits the previous slot's image first so a screen frame with no new
/// camera frame keeps showing the last one, then advances the decoder while it
/// is behind.
///
/// The frame that overshoots the target is staged anyway rather than dropped:
/// it costs at most one camera interval of lead (~33ms at 30fps, invisible on
/// an overlay), and the alternative is discarding camera frames whenever the
/// screen ticks faster than the camera.
fn advance_webcam(
  chain: &mut RenderChain,
  webcam: &mut Option<Decoder>,
  sync: &mut WebcamSync,
  previous_slot: Option<usize>,
  slot: usize,
  target_ms: f64,
) {
  let Some(decoder) = webcam.as_mut() else {
    return;
  };

  if let Some(previous) = previous_slot {
    let _ = chain.inherit_webcam(previous, slot);
  }

  // Still ahead of this frame: the inherited image is the right one.
  if sync.ahead_ms.is_some_and(|ahead| ahead > target_ms) {
    return;
  }

  loop {
    let sample = match decoder.read_sample() {
      Ok(sample) => sample,
      Err(_) => {
        sync.ahead_ms = None;
        return;
      }
    };

    if sample.end_of_stream {
      // Leave the last image in place rather than blanking the overlay when the
      // camera track ends before the screen recording.
      sync.ahead_ms = Some(f64::INFINITY);
      return;
    }

    let Some(texture) = sample.texture.as_ref() else {
      continue;
    };

    if chain
      .stage_webcam(slot, texture, sample.subresource)
      .is_err()
    {
      return;
    }

    let pts_ms = sample.timestamp_100ns as f64 / 10_000.0;
    if pts_ms > target_ms {
      sync.ahead_ms = Some(pts_ms);
      return;
    }
    sync.ahead_ms = None;
  }
}

fn decode_loop(
  shared: Arc<Shared>,
  rx: Receiver<Command>,
  mut decoder: Decoder,
  mut webcam: Option<Decoder>,
  pool: Vec<SharedTexture>,
  pool_rtvs: Vec<ID3D11RenderTargetView>,
  mut chain: RenderChain,
) {
  let mut next_slot = 0usize;
  let mut previous_slot: Option<usize> = None;
  let mut webcam_sync = WebcamSync::default();

  while shared.running.load(Ordering::Acquire) {
    // Drain everything pending and keep only the last of each kind. A slider
    // drag emits a change per pixel of travel; applying every one of them in
    // turn is pure backlog, and only the final value is ever seen.
    let mut pending_effects: Option<EffectParams> = None;
    let mut pending_seek: Option<(f64, SeekMode)> = None;
    let mut pending_webcam_layout: Option<WebcamLayout> = None;
    let mut pending_cursor_image: Option<Option<CursorImage>> = None;
    let mut pending_cursor_track: Option<Vec<CursorSample>> = None;
    let mut pending_cursor_style: Option<(f32, f32)> = None;
    let mut stopping = false;
    loop {
      match rx.try_recv() {
        Ok(Command::Stop) | Err(TryRecvError::Disconnected) => {
          stopping = true;
          break;
        }
        Ok(Command::Seek(target, mode)) => pending_seek = Some((target, mode)),
        Ok(Command::SetEffects(params)) => pending_effects = Some(params),
        Ok(Command::SetWebcamLayout(layout)) => pending_webcam_layout = Some(layout),
        Ok(Command::SetCursorImage(image)) => pending_cursor_image = Some(image),
        Ok(Command::SetCursorTrack(samples)) => pending_cursor_track = Some(samples),
        Ok(Command::SetCursorStyle(size, opacity)) => pending_cursor_style = Some((size, opacity)),
        // Answered inline rather than coalesced: a snapshot is a question, and
        // dropping all but the last would leave earlier callers waiting forever.
        Ok(Command::Snapshot(reply)) => {
          let current = *shared.current.lock().unwrap();
          let pixels = current.and_then(|frame| {
            let texture = &pool[frame.slot % pool.len()];
            crate::engine::d3d::read_bgra(&texture.texture, texture.width, texture.height).ok()
          });
          let _ = reply.send(pixels);
        }
        Err(TryRecvError::Empty) => break,
      }
    }
    if stopping {
      break;
    }

    // Anything that changes how a staged frame looks gets the same treatment:
    // apply it, then re-render what the player is already holding rather than
    // going back to the decoder.
    let mut needs_repaint = false;

    if let Some(params) = pending_effects {
      chain.set_params(params);
      needs_repaint = true;
    }

    if let Some(layout) = pending_webcam_layout {
      chain.set_webcam_layout(layout);
      needs_repaint = true;
    }

    if let Some(image) = pending_cursor_image {
      let sprite = image.and_then(|image| {
        SpriteTexture::new(
          image.width,
          image.height,
          &image.pixels,
          image.hotspot_x,
          image.hotspot_y,
        )
        .ok()
      });
      chain.set_cursor_image(sprite);
      needs_repaint = true;
    }

    if let Some(samples) = pending_cursor_track {
      let track = CursorTrack::new(samples);
      shared
        .cursor_samples
        .store(track.len() as u64, Ordering::Release);
      chain.set_cursor_track(track);
      needs_repaint = true;
    }

    if let Some((size, opacity)) = pending_cursor_style {
      chain.set_cursor_style(size, opacity);
      needs_repaint = true;
    }

    if needs_repaint {
      repaint_slots(&shared, &mut chain, &pool_rtvs);
    }

    if let Some((target, mode)) = pending_seek {
      do_seek(
        &shared,
        &mut decoder,
        &mut webcam,
        &mut webcam_sync,
        &mut chain,
        &pool,
        &pool_rtvs,
        &mut next_slot,
        target,
        mode,
      );
      continue;
    }

    if shared.eof.load(Ordering::Acquire) {
      // Nothing left to decode; stay responsive to seeks without spinning.
      std::thread::sleep(Duration::from_millis(5));
      continue;
    }

    // Backpressure. Time out rather than waiting forever, so commands still get
    // seen while the queue is full.
    {
      let queue = shared.frames.lock().unwrap();
      if queue.len() >= QUEUE_CAPACITY {
        let _ = shared
          .space
          .wait_timeout(queue, Duration::from_millis(10))
          .unwrap();
        continue;
      }
    }

    let started = Instant::now();
    let sample = match decoder.read_sample() {
      Ok(s) => s,
      Err(_) => {
        shared.eof.store(true, Ordering::Release);
        continue;
      }
    };

    if sample.end_of_stream {
      shared.eof.store(true, Ordering::Release);
      continue;
    }

    let Some(source) = sample.texture.as_ref() else {
      shared.skipped_no_texture.fetch_add(1, Ordering::Relaxed);
      continue;
    };
    let slot_index = next_slot;
    let slot = &pool[slot_index];
    next_slot = (next_slot + 1) % pool.len();

    let pts_ms = sample.timestamp_100ns as f64 / 10_000.0;

    // Bring the other layers to this frame's time before compositing it. Both
    // are staged against the slot rather than applied globally, so re-rendering
    // this frame later puts the camera image and the pointer back where this
    // frame had them.
    advance_webcam(
      &mut chain,
      &mut webcam,
      &mut webcam_sync,
      previous_slot,
      slot_index,
      pts_ms,
    );
    chain.stage_cursor(slot_index, pts_ms);
    previous_slot = Some(slot_index);

    // Decode output goes through the render layer on its way to the pool, so
    // the preview shows exactly what an export would write. The NV12 source
    // stays in the slot afterwards so the frame can be re-rendered.
    if chain
      .process(slot_index, source, sample.subresource, &pool_rtvs[slot_index])
      .is_err()
    {
      shared.skipped_render_error.fetch_add(1, Ordering::Relaxed);
      continue;
    }

    shared
      .decode_us_total
      .fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
    shared.decoded.fetch_add(1, Ordering::Relaxed);

    let frame = make_frame(&shared, slot_index, slot, pts_ms);
    shared.frames.lock().unwrap().push_back(frame);
  }
}

/// Re-render frames the player is already holding under new settings.
///
/// Covers grading, the webcam box and the cursor: anything that changes how an
/// already-decoded frame looks.
///
/// This is the whole reason each slot keeps its decoded NV12: a colour change
/// costs a few GPU passes rather than a seek and a GOP of decoding.
///
/// While paused only the frame on screen matters, and re-rendering the queue
/// would be work nobody sees. While playing the queue drains in front of the
/// viewer, so it gets re-rendered in place -- no re-decode, no jump, and no
/// stretch of old-looking frames.
fn repaint_slots(
  shared: &Arc<Shared>,
  chain: &mut RenderChain,
  pool_rtvs: &[ID3D11RenderTargetView],
) {
  let playing = shared.clock.lock().unwrap().playing;

  if playing {
    let queued: Vec<(usize, f64)> = shared
      .frames
      .lock()
      .unwrap()
      .iter()
      .map(|f| (f.slot, f.pts_ms))
      .collect();
    for (slot, pts_ms) in queued {
      // Re-resolve the pointer as well as re-rendering. The cursor's position,
      // size and visibility are all derived from settings that may be exactly
      // what just changed, and a slot remembers the rect it was staged with --
      // so without this, hiding the cursor or resizing it leaves every frame
      // already in flight showing the old one.
      chain.stage_cursor(slot, pts_ms);
      let _ = chain.render_slot(slot, &pool_rtvs[slot]);
    }
    return;
  }

  let current = *shared.current.lock().unwrap();
  if let Some(frame) = current {
    chain.stage_cursor(frame.slot, frame.pts_ms);
    if chain
      .render_slot(frame.slot, &pool_rtvs[frame.slot])
      .is_ok()
    {
      // A paused player has no clock motion to bring the new look on screen by
      // itself, so ask tick to hand the same frame out again.
      shared.repaint.store(true, Ordering::Release);
    }
  }
}

/// Seek, then decode forward to the frame that actually covers `target`.
///
/// Media Foundation lands on the nearest preceding keyframe, so without this
/// step every seek would be off by up to a whole GOP.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
fn do_seek(
  shared: &Arc<Shared>,
  decoder: &mut Decoder,
  webcam: &mut Option<Decoder>,
  webcam_sync: &mut WebcamSync,
  chain: &mut RenderChain,
  pool: &[SharedTexture],
  pool_rtvs: &[ID3D11RenderTargetView],
  next_slot: &mut usize,
  target: f64,
  mode: SeekMode,
) {
  let started = Instant::now();
  let mut decoded_here = 0u64;

  shared.frames.lock().unwrap().clear();
  shared.space.notify_all();
  shared.eof.store(false, Ordering::Release);

  if decoder.seek((target * 10_000.0) as i64).is_err() {
    return;
  }

  // Move the camera with the screen. Every staged webcam frame belongs to the
  // old position, and holding one over the new one would show the wrong face at
  // the wrong moment -- worse than showing nothing, because it looks correct.
  if let Some(webcam) = webcam.as_mut() {
    chain.clear_webcam_staging();
    *webcam_sync = WebcamSync::default();
    let _ = webcam.seek((target * 10_000.0) as i64);
  }

  // The frame on screen at time t is the last one whose pts is <= t, so decode
  // one past the target and keep the previous.
  //
  // Only the kept frame gets rendered. Scanning a long GOP and running the
  // chain on every frame roughly doubled seek cost for output nobody sees, so
  // candidates are stashed with a plain blit and rendered once at the end.
  let mut previous: Option<(usize, f64)> = None;
  let mut chosen: Option<(usize, f64)> = None;

  // Fast mode wants exactly one frame: whatever the keyframe seek landed on.
  let budget = if mode == SeekMode::Fast { 1 } else { MAX_SEEK_DECODE };

  for _ in 0..budget {
    let sample = match decoder.read_sample() {
      Ok(s) => s,
      Err(_) => break,
    };
    if sample.end_of_stream {
      shared.eof.store(true, Ordering::Release);
      break;
    }

    let Some(source) = sample.texture.as_ref() else {
      break;
    };

    let pts_ms = sample.timestamp_100ns as f64 / 10_000.0;

    // Stage only. Scanning a GOP and rendering every frame is wasted work when
    // all but one gets thrown away, but the decoder reuses its array slices, so
    // a candidate still has to be copied somewhere we own.
    let slot_index = *next_slot;
    *next_slot = (*next_slot + 1) % pool.len();
    if chain.stage(slot_index, source, sample.subresource).is_err() {
      break;
    }
    decoded_here += 1;

    if mode == SeekMode::Fast {
      previous = Some((slot_index, pts_ms));
      break;
    }

    if pts_ms > target {
      // Overshot: the previous frame is the right one, unless the target sits
      // before the first frame we could decode.
      chosen = previous.or(Some((slot_index, pts_ms)));
      break;
    }
    previous = Some((slot_index, pts_ms));
  }

  if let Some((slot_index, pts_ms)) = chosen.or(previous) {
    // Only the frame we landed on gets its layers composed. Doing it for every
    // candidate would decode a GOP of camera frames to throw them away, which
    // is exactly the cost the staged-not-rendered seek path exists to avoid.
    advance_webcam(chain, webcam, webcam_sync, None, slot_index, pts_ms);
    chain.stage_cursor(slot_index, pts_ms);

    if chain.render_slot(slot_index, &pool_rtvs[slot_index]).is_ok() {
      // Anchor playback to where we actually landed, not where we aimed, so
      // the clock and the picture agree.
      shared.clock.lock().unwrap().jump_to(pts_ms);
      let frame = make_frame(shared, slot_index, &pool[slot_index], pts_ms);
      shared.frames.lock().unwrap().push_back(frame);
    }
  }

  shared
    .last_seek_us
    .store(started.elapsed().as_micros() as u64, Ordering::Relaxed);
  shared
    .last_seek_decoded
    .store(decoded_here, Ordering::Relaxed);
}
