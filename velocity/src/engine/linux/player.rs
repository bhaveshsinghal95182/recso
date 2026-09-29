//! A bounded, clock-driven editor preview on Linux.
//!
//! The Windows player establishes four rules: a pool prevents overwriting a
//! frame in flight, decode stays off the JS thread, an engine clock decides
//! what `tick` presents, and exact seeks decode forward from a keyframe. This
//! player keeps those rules. Its render output is read back from wgpu and
//! copied into stable GBM DMA-BUFs instead of a shared D3D11 texture pool.

use std::collections::VecDeque;
use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use openh264::decoder::Decoder;
use openh264::formats::YUVSource;

use super::media::SourceInfo;
use super::present::PresentPool;
use super::render::RenderChain;
use crate::engine::cuts::{Cut, CutTrack};
use crate::engine::layout::{CursorSample, CursorTrack, WebcamLayout};
use crate::engine::scene::{BackgroundRequest, CursorEffects, EffectParams, Layer, SourceCrop, VideoLayout};
use crate::engine::zoom::{WebcamZoomRegion, WebcamZoomTrack, ZoomRegion, ZoomTrack};
use super::api::SharedTextureInfo;

const QUEUE_CAPACITY: usize = 12;
const POOL_SLACK: usize = 6;
const MAX_SEEK_DECODE: usize = 600;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// The pool slot and composition time of a rendered frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct QueuedFrame {
  pub slot: usize,
  pub pts_ms: f64,
  pub generation: u64,
}

/// Maps wall time to the composition timeline.
struct Clock {
  playing: bool,
  rate: f64,
  anchor_media_ms: f64,
  anchor_at: Instant,
  duration_ms: f64,
}
impl Clock {
  fn now_ms(&self) -> f64 {
    let raw = if self.playing {
      self.anchor_media_ms + self.anchor_at.elapsed().as_secs_f64() * 1000.0 * self.rate
    } else { self.anchor_media_ms };
    raw.clamp(0.0, self.duration_ms.max(0.0))
  }
  fn reanchor(&mut self) {
    self.anchor_media_ms = self.now_ms();
    self.anchor_at = Instant::now();
  }
  fn set_playing(&mut self, playing: bool) { self.reanchor(); self.playing = playing; }
  fn set_rate(&mut self, rate: f64) { self.reanchor(); self.rate = rate.clamp(0.1, 8.0); }
  fn jump_to(&mut self, ms: f64) { self.anchor_media_ms = ms; self.anchor_at = Instant::now(); }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SeekMode { Fast, Exact }

/// Plain pixels cross the command channel; GPU resources stay on the worker.
pub(crate) use super::render::CursorImage;

enum Command {
  Seek(f64, SeekMode),
  Effects(EffectParams), WebcamEffects(EffectParams), Layout(VideoLayout),
  Background(BackgroundRequest), Zoom(Vec<ZoomRegion>), Cuts(Vec<Cut>),
  Crop(Option<SourceCrop>), WebcamLayout(WebcamLayout),
  CursorImage(Option<CursorImage>), CursorImages(Vec<CursorImage>),
  CursorTrack(Vec<CursorSample>), CursorStyle(f32, f32),
  CursorEffects(CursorEffects), WebcamCuts(Vec<(f64, f64)>),
  LayerOrder([Layer; 3]), WebcamZoom(Vec<WebcamZoomRegion>),
  Snapshot(Sender<Option<Vec<u8>>>), Stop,
}

struct Shared {
  frames: Mutex<VecDeque<QueuedFrame>>,
  space: Condvar,
  clock: Mutex<Clock>,
  generation: AtomicU64,
  running: AtomicBool,
  eof: AtomicBool,
  force_present: AtomicBool,
  current: Mutex<Option<QueuedFrame>>,
  repaint: AtomicBool,
  has_webcam: bool,
  source: SourceInfo,
  canvas: (u32, u32),
  descriptors: Vec<SharedTextureInfo>,
  cursor_samples: AtomicU64,
  cursor_images: AtomicU64,
  zoom_regions: AtomicU64,
  cut_count: AtomicU64,
  decoded: AtomicU64,
  dropped: AtomicU64,
  skipped_render_error: AtomicU64,
  max_queue_wait_us: AtomicU64,
  decode_us_total: AtomicU64,
  last_seek_us: AtomicU64,
  last_seek_decoded: AtomicU64,
}

pub struct Stats {
  pub queue_depth: u32, pub decoded: u64, pub dropped: u64,
  pub skipped_no_texture: u64, pub skipped_render_error: u64,
  pub max_queue_wait_us: u64, pub avg_decode_ms: f64,
  pub last_seek_ms: f64, pub last_seek_decoded: u32,
  pub end_of_stream: bool, pub playing: bool,
  pub current_time_ms: f64, pub rate: f64,
}

pub struct Player {
  shared: Arc<Shared>,
  tx: Sender<Command>,
  thread: Option<JoinHandle<()>>,
}
impl Player {
  pub fn open(path: &str) -> Result<Self, String> { Self::open_with_webcam(path, None, None) }

  /// Open a screen recording and an optional camera sidecar under one clock.
  pub fn open_with_webcam(path: &str, webcam_path: Option<&str>, canvas: Option<(u32, u32)>) -> Result<Self, String> {
    let decoder = PlaneSource::open(path)?;
    let webcam = webcam_path.and_then(|path| match PlaneSource::open(path) {
      Ok(source) => Some(source),
      Err(error) => { eprintln!("[engine] webcam sidecar {path} did not open: {error}"); None }
    });
    let info = decoder.info;
    let webcam_size = webcam.as_ref().map(|source| (source.info.width, source.info.height));
    let canvas = match canvas {
      Some((width, height)) if width >= 2 && height >= 2 => (width & !1, height & !1),
      _ => (info.width & !1, info.height & !1),
    };
    let pool = PresentPool::new(canvas.0, canvas.1, QUEUE_CAPACITY + POOL_SLACK)?;
    let descriptors = pool.descriptors();
    let shared = Arc::new(Shared {
      frames: Mutex::new(VecDeque::with_capacity(QUEUE_CAPACITY)), space: Condvar::new(),
      clock: Mutex::new(Clock { playing: false, rate: 1.0, anchor_media_ms: 0.0,
        anchor_at: Instant::now(), duration_ms: info.duration_ms }),
      generation: AtomicU64::new(0), running: AtomicBool::new(true),
      eof: AtomicBool::new(false), force_present: AtomicBool::new(true),
      current: Mutex::new(None), repaint: AtomicBool::new(false),
      has_webcam: webcam.is_some(), source: info, canvas, descriptors,
      cursor_samples: AtomicU64::new(0), cursor_images: AtomicU64::new(0),
      zoom_regions: AtomicU64::new(0), cut_count: AtomicU64::new(0),
      decoded: AtomicU64::new(0), dropped: AtomicU64::new(0),
      skipped_render_error: AtomicU64::new(0), max_queue_wait_us: AtomicU64::new(0),
      decode_us_total: AtomicU64::new(0), last_seek_us: AtomicU64::new(0),
      last_seek_decoded: AtomicU64::new(0),
    });
    let (tx, rx) = std::sync::mpsc::channel();
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let thread_shared = Arc::clone(&shared);
    let thread = std::thread::Builder::new().name("linux-preview-decode".into())
      .spawn(move || {
        // OpenH264 hands back planes of the display size, not the macroblock-
        // padded one, so the chain's source textures are sized to match.
        let chain = RenderChain::new((info.width, info.height),
          (info.width, info.height), canvas, QUEUE_CAPACITY + POOL_SLACK)
          .and_then(|mut chain| {
            if let Some((width, height)) = webcam_size { chain.attach_webcam(width, height)?; }
            Ok(chain)
          });
        match chain {
          Ok(mut chain) => {
            chain.set_layout(VideoLayout::covering(canvas.0, canvas.1));
            let _ = ready_tx.send(Ok(()));
            decode_loop(thread_shared, rx, decoder, webcam, pool, chain);
          }
          Err(error) => { let _ = ready_tx.send(Err(error)); }
        }
      }).map_err(|error| format!("failed to spawn decode thread: {error}"))?;
    ready_rx.recv().map_err(|error| format!("decode thread did not start: {error}"))??;
    Ok(Self { shared, tx, thread: Some(thread) })
  }

  pub(super) fn info(&self) -> (SourceInfo, (u32, u32)) { (self.shared.source, self.shared.canvas) }
  pub fn pool_textures(&self) -> Vec<SharedTextureInfo> { self.shared.descriptors.clone() }
  pub fn texture_info(&self, frame: QueuedFrame) -> SharedTextureInfo {
    let mut info = self.shared.descriptors[frame.slot].clone();
    info.timestamp = frame.pts_ms * 1000.0;
    info
  }
  pub fn set_playing(&self, playing: bool) {
    if playing && self.shared.eof.load(Ordering::Acquire) && lock(&self.shared.frames).is_empty() {
      self.seek(0.0, SeekMode::Exact);
    }
    lock(&self.shared.clock).set_playing(playing);
  }
  pub fn set_rate(&self, rate: f64) { lock(&self.shared.clock).set_rate(rate); }
  fn send(&self, command: Command) { let _ = self.tx.send(command); self.shared.space.notify_all(); }
  pub fn set_effects(&self, value: EffectParams) { self.send(Command::Effects(value)); }
  pub fn set_webcam_effects(&self, value: EffectParams) { self.send(Command::WebcamEffects(value)); }
  pub fn set_layout(&self, value: VideoLayout) { self.send(Command::Layout(value)); }
  pub fn set_background(&self, value: BackgroundRequest) { self.send(Command::Background(value)); }
  pub fn set_zoom_regions(&self, value: Vec<ZoomRegion>) { self.send(Command::Zoom(value)); }
  pub fn set_cuts(&self, value: Vec<Cut>) { self.send(Command::Cuts(value)); }
  pub fn set_source_crop(&self, value: Option<SourceCrop>) { self.send(Command::Crop(value)); }
  pub fn set_webcam_layout(&self, value: WebcamLayout) { self.send(Command::WebcamLayout(value)); }
  pub fn set_cursor_image(&self, value: Option<CursorImage>) { self.send(Command::CursorImage(value)); }
  pub fn set_cursor_images(&self, value: Vec<CursorImage>) { self.send(Command::CursorImages(value)); }
  pub fn set_cursor_track(&self, value: Vec<CursorSample>) { self.send(Command::CursorTrack(value)); }
  pub fn set_cursor_style(&self, size: f32, opacity: f32) { self.send(Command::CursorStyle(size, opacity)); }
  pub fn set_cursor_effects(&self, value: CursorEffects) { self.send(Command::CursorEffects(value)); }
  pub fn set_webcam_cuts(&self, value: Vec<(f64, f64)>) { self.send(Command::WebcamCuts(value)); }
  pub fn set_layer_order(&self, value: [Layer; 3]) { self.send(Command::LayerOrder(value)); }
  pub fn set_webcam_zoom_regions(&self, value: Vec<WebcamZoomRegion>) { self.send(Command::WebcamZoom(value)); }
  pub fn has_webcam(&self) -> bool { self.shared.has_webcam }
  pub fn cursor_sample_count(&self) -> u64 { self.shared.cursor_samples.load(Ordering::Acquire) }
  pub fn cursor_image_count(&self) -> u64 { self.shared.cursor_images.load(Ordering::Acquire) }
  pub fn zoom_region_count(&self) -> u64 { self.shared.zoom_regions.load(Ordering::Acquire) }
  pub fn cut_count(&self) -> u64 { self.shared.cut_count.load(Ordering::Acquire) }
  pub fn composition_duration_ms(&self) -> f64 { lock(&self.shared.clock).duration_ms }
  pub fn snapshot_bgra(&self) -> Option<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    self.send(Command::Snapshot(tx));
    rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
  }
  pub fn seek(&self, ms: f64, mode: SeekMode) {
    let mut clock = lock(&self.shared.clock);
    let clamped = if ms.is_finite() { ms.clamp(0.0, clock.duration_ms.max(0.0)) } else { 0.0 };
    self.shared.generation.fetch_add(1, Ordering::AcqRel);
    self.shared.force_present.store(true, Ordering::Release);
    clock.jump_to(clamped);
    drop(clock);
    self.send(Command::Seek(clamped, mode));
  }
  /// Select the latest due frame, discarding earlier overdue frames.
  pub fn tick(&self) -> Option<QueuedFrame> {
    let now = lock(&self.shared.clock).now_ms();
    let generation = self.shared.generation.load(Ordering::Acquire);
    let force = self.shared.force_present.load(Ordering::Acquire);
    let waited = Instant::now();
    let mut queue = lock(&self.shared.frames);
    self.shared.max_queue_wait_us.fetch_max(waited.elapsed().as_micros() as u64, Ordering::Relaxed);
    let draining = self.shared.eof.load(Ordering::Acquire) && now >= self.shared.source.duration_ms - 0.001;
    let (mut chosen, dropped) = select_due(&mut queue, now, generation, force, draining);
    self.shared.dropped.fetch_add(dropped, Ordering::Relaxed);
    if let Some(frame) = chosen {
      self.shared.force_present.store(false, Ordering::Release);
      *lock(&self.shared.current) = Some(frame);
      self.shared.space.notify_all();
    } else if self.shared.repaint.swap(false, Ordering::AcqRel) {
      chosen = *lock(&self.shared.current);
    }
    let empty = queue.is_empty();
    drop(queue);
    if empty && self.shared.eof.load(Ordering::Acquire) {
      let mut clock = lock(&self.shared.clock);
      if clock.playing { clock.playing = false; let end = clock.duration_ms; clock.jump_to(end); }
    }
    chosen
  }
  pub fn stats(&self) -> Stats {
    let clock = lock(&self.shared.clock);
    let decoded = self.shared.decoded.load(Ordering::Relaxed);
    Stats {
      queue_depth: lock(&self.shared.frames).len() as u32, decoded,
      dropped: self.shared.dropped.load(Ordering::Relaxed), skipped_no_texture: 0,
      skipped_render_error: self.shared.skipped_render_error.load(Ordering::Relaxed),
      max_queue_wait_us: self.shared.max_queue_wait_us.load(Ordering::Relaxed),
      avg_decode_ms: self.shared.decode_us_total.load(Ordering::Relaxed) as f64 / decoded.max(1) as f64 / 1000.0,
      last_seek_ms: self.shared.last_seek_us.load(Ordering::Relaxed) as f64 / 1000.0,
      last_seek_decoded: self.shared.last_seek_decoded.load(Ordering::Relaxed) as u32,
      end_of_stream: self.shared.eof.load(Ordering::Acquire), playing: clock.playing,
      current_time_ms: clock.now_ms(), rate: clock.rate,
    }
  }
  pub fn close(&mut self) {
    self.shared.running.store(false, Ordering::Release);
    self.send(Command::Stop);
    if let Some(thread) = self.thread.take() { let _ = thread.join(); }
  }
}
impl Drop for Player { fn drop(&mut self) { self.close(); } }

fn select_due(queue: &mut VecDeque<QueuedFrame>, now: f64, generation: u64,
  force: bool, draining: bool) -> (Option<QueuedFrame>, u64) {
  while queue.front().is_some_and(|frame| frame.generation < generation) { queue.pop_front(); }
  let mut chosen = None;
  let mut dropped = 0;
  while let Some(&front) = queue.front() {
    if !force && !draining && front.pts_ms > now { break; }
    queue.pop_front();
    if chosen.is_some() { dropped += 1; }
    chosen = Some(front);
    if force { break; }
  }
  (chosen, dropped)
}

/// One decoded I420 frame, owned after OpenH264 advances to the next sample.
struct PlaneFrame {
  pts_ms: f64,
  y: Vec<u8>, u: Vec<u8>, v: Vec<u8>,
  strides: (usize, usize, usize),
}
impl PlaneFrame {
  fn stage(&self, chain: &mut RenderChain, slot: usize) -> Result<(), String> {
    chain.stage(slot, &self.y, &self.u, &self.v, self.strides)
  }
}

/// Local demuxer keeps OpenH264's planes before RGBA conversion discards them.
struct PlaneSource {
  reader: mp4::Mp4Reader<BufReader<File>>,
  decoder: Decoder,
  track_id: u32,
  timescale: u32,
  sps: Vec<u8>, pps: Vec<u8>,
  info: SourceInfo,
  next_sample: u32,
}
impl PlaneSource {
  fn open(path: &str) -> Result<Self, String> {
    let file = File::open(path).map_err(|error| format!("failed to open {path}: {error}"))?;
    let reader = mp4::read_mp4(file).map_err(|error| format!("failed to read {path} as MP4: {error}"))?;
    let track = reader.tracks().values()
      .filter(|track| track.media_type().ok() == Some(mp4::MediaType::H264))
      .min_by_key(|track| track.track_id())
      .ok_or_else(|| format!("no H.264 video track in {path}"))?;
    let sps = track.sequence_parameter_set().map_err(|error| error.to_string())?.to_vec();
    let pps = track.picture_parameter_set().map_err(|error| error.to_string())?.to_vec();
    let duration_ms = track.duration().as_secs_f64() * 1000.0;
    let sample_count = track.sample_count();
    let width = track.width() as u32;
    let height = track.height() as u32;
    let info = SourceInfo { width, height,
      coded_width: width.saturating_add(15) / 16 * 16,
      coded_height: height.saturating_add(15) / 16 * 16,
      duration_ms, fps: if duration_ms > 0.0 { sample_count as f64 * 1000.0 / duration_ms } else { 0.0 },
      sample_count };
    let track_id = track.track_id();
    let timescale = track.timescale();
    if timescale == 0 { return Err("video track has zero timescale".into()); }
    let decoder = Decoder::new().map_err(|error| error.to_string())?;
    Ok(Self { reader, decoder, track_id, timescale, sps, pps, info, next_sample: 1 })
  }
  fn next_frame(&mut self) -> Result<Option<PlaneFrame>, String> {
    while self.next_sample <= self.info.sample_count {
      let sample_id = self.next_sample;
      self.next_sample += 1;
      let sample = self.reader.read_sample(self.track_id, sample_id)
        .map_err(|error| error.to_string())?.ok_or_else(|| format!("video sample {sample_id} is missing"))?;
      let mut annexb = Vec::with_capacity(sample.bytes.len() + self.sps.len() + self.pps.len() + 12);
      if sample.is_sync { append_nal(&mut annexb, &self.sps); append_nal(&mut annexb, &self.pps); }
      let mut bytes = sample.bytes.as_ref();
      while !bytes.is_empty() {
        if bytes.len() < 4 { return Err(format!("video sample {sample_id} has an incomplete NAL length")); }
        let size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        bytes = &bytes[4..];
        if size == 0 || size > bytes.len() { return Err(format!("video sample {sample_id} has an invalid NAL length")); }
        append_nal(&mut annexb, &bytes[..size]);
        bytes = &bytes[size..];
      }
      let Some(decoded) = self.decoder.decode(&annexb).map_err(|error| error.to_string())? else { continue };
      let pts = sample.start_time as i128 + sample.rendering_offset as i128;
      return Ok(Some(PlaneFrame {
        pts_ms: pts.max(0) as f64 * 1000.0 / self.timescale as f64,
        y: decoded.y().to_vec(), u: decoded.u().to_vec(), v: decoded.v().to_vec(),
        strides: decoded.strides(),
      }));
    }
    Ok(None)
  }
  fn seek_to_keyframe_before(&mut self, ms: f64) -> Result<(), String> {
    let target = if ms.is_finite() { ms.max(0.0) } else { 0.0 };
    let mut chosen = 1;
    for sample_id in 1..=self.info.sample_count {
      let sample = self.reader.read_sample(self.track_id, sample_id)
        .map_err(|error| error.to_string())?.ok_or_else(|| format!("video sample {sample_id} is missing"))?;
      let pts = sample.start_time as i128 + sample.rendering_offset as i128;
      let pts_ms = pts.max(0) as f64 * 1000.0 / self.timescale as f64;
      if sample.is_sync && pts_ms <= target { chosen = sample_id; }
    }
    self.decoder = Decoder::new().map_err(|error| error.to_string())?;
    self.next_sample = chosen;
    Ok(())
  }
}
fn append_nal(target: &mut Vec<u8>, nal: &[u8]) {
  target.extend_from_slice(&[0, 0, 0, 1]);
  target.extend_from_slice(nal);
}

/// The camera picture the next screen frame should carry.
///
/// A fresh camera frame is uploaded into the screen frame's slot; otherwise the
/// previous slot's camera texture is copied across on the GPU, which is what
/// Windows' `inherit_webcam` does. Most screen frames reuse the camera picture,
/// so this saves an upload per frame.
#[derive(Default)]
struct OverlayState {
  webcam_frame: Option<PlaneFrame>,
  webcam_fresh: bool,
  webcam_slot: Option<usize>,
}
impl OverlayState {
  fn stage_webcam(&mut self, chain: &mut RenderChain, slot: usize) {
    let Some(frame) = self.webcam_frame.as_ref() else { return };
    let staged = match self.webcam_slot {
      Some(previous) if !self.webcam_fresh => chain.inherit_webcam(previous, slot),
      _ => chain.stage_webcam(slot, &frame.y, &frame.u, &frame.v, frame.strides),
    };
    match staged {
      Ok(()) => { self.webcam_fresh = false; self.webcam_slot = Some(slot); }
      Err(error) => eprintln!("[engine] webcam frame not staged: {error}"),
    }
  }
  /// Forget the camera picture, as after a seek.
  fn reset(&mut self, chain: &mut RenderChain) {
    *self = Self::default();
    chain.clear_webcam_staging();
  }
}

fn render_frame(chain: &mut RenderChain, pool: &mut PresentPool, slot: usize,
  pts_ms: f64, rgba: &mut Vec<u8>) -> Result<(), String> {
  chain.stage_timeline(slot, pts_ms);
  chain.render_slot(slot)?;
  chain.read_rgba(rgba)?;
  let (width, height) = chain.output_size();
  pool.write(slot, rgba, width, height)
}

fn repaint_slots(shared: &Shared, chain: &mut RenderChain, pool: &mut PresentPool,
  rgba: &mut Vec<u8>) {
  let playing = lock(&shared.clock).playing;
  if playing {
    let queued: Vec<_> = lock(&shared.frames).iter().copied().collect();
    for frame in queued { let _ = render_frame(chain, pool, frame.slot, frame.pts_ms, rgba); }
  } else if let Some(frame) = *lock(&shared.current) {
    if render_frame(chain, pool, frame.slot, frame.pts_ms, rgba).is_ok() {
      shared.repaint.store(true, Ordering::Release);
    }
  }
}

fn do_seek(shared: &Shared, decoder: &mut PlaneSource, webcam: &mut Option<PlaneSource>,
  overlays: &mut OverlayState, latest_webcam_ms: &mut f64,
  chain: &mut RenderChain, pool: &mut PresentPool, cuts: &CutTrack,
  next_slot: &mut usize, target: f64, mode: SeekMode, rgba: &mut Vec<u8>) {
  let started = Instant::now();
  lock(&shared.frames).clear();
  shared.eof.store(false, Ordering::Release);
  let source_target = cuts.to_source(target);
  if decoder.seek_to_keyframe_before(source_target).is_err() { return; }
  if let Some(source) = webcam.as_mut() { let _ = source.seek_to_keyframe_before(source_target); }
  let mut previous: Option<(PlaneFrame, f64)> = None;
  let mut chosen = None;
  let mut decoded = 0;
  let budget = if mode == SeekMode::Fast { 1 } else { MAX_SEEK_DECODE };
  for _ in 0..budget {
    let frame = match decoder.next_frame() {
      Ok(Some(frame)) => frame,
      Ok(None) => { shared.eof.store(true, Ordering::Release); break; }
      Err(_) => break,
    };
    if cuts.contains(frame.pts_ms) { continue; }
    let composition_ms = cuts.to_composition(frame.pts_ms);
    decoded += 1;
    if mode == SeekMode::Fast { previous = Some((frame, composition_ms)); break; }
    if composition_ms > target {
      chosen = previous.take().or(Some((frame, composition_ms)));
      break;
    }
    previous = Some((frame, composition_ms));
  }
  if let Some((frame, composition_ms)) = chosen.or(previous) {
    pull_webcam(webcam, overlays, latest_webcam_ms, frame.pts_ms);
    let slot = *next_slot;
    *next_slot = (*next_slot + 1) % pool.len();
    overlays.stage_webcam(chain, slot);
    if frame.stage(chain, slot).and_then(|()|
      render_frame(chain, pool, slot, composition_ms, rgba)).is_ok() {
      lock(&shared.clock).jump_to(composition_ms);
      lock(&shared.frames).push_back(QueuedFrame {
        slot, pts_ms: composition_ms, generation: shared.generation.load(Ordering::Acquire),
      });
    }
  }
  shared.last_seek_us.store(started.elapsed().as_micros() as u64, Ordering::Relaxed);
  shared.last_seek_decoded.store(decoded, Ordering::Relaxed);
}

/// Retain the camera picture nearest this screen frame on the same worker.
fn pull_webcam(webcam: &mut Option<PlaneSource>, overlays: &mut OverlayState,
  latest_ms: &mut f64, target_ms: f64) {
  let Some(webcam) = webcam.as_mut() else { return };
  while *latest_ms <= target_ms {
    match webcam.next_frame() {
      Ok(Some(frame)) => {
        *latest_ms = frame.pts_ms;
        overlays.webcam_frame = Some(frame);
        overlays.webcam_fresh = true;
      }
      _ => { *latest_ms = f64::INFINITY; break; }
    }
  }
}

fn decode_loop(shared: Arc<Shared>, rx: Receiver<Command>, mut decoder: PlaneSource,
  mut webcam: Option<PlaneSource>, mut pool: PresentPool, mut chain: RenderChain) {
  let mut next_slot = 0;
  let mut cuts = CutTrack::default();
  let mut overlays = OverlayState::default();
  let mut rgba = Vec::new();
  let mut latest_webcam_ms = f64::NEG_INFINITY;
  let mut skipping_past = None;
  while shared.running.load(Ordering::Acquire) {
    let mut repaint = false;
    let mut seek = None;
    let mut snapshots = Vec::new();
    while let Ok(command) = rx.try_recv() {
      match command {
        Command::Stop => return,
        Command::Seek(ms, mode) => seek = Some((ms, mode)),
        Command::Effects(value) => { chain.set_params(value); repaint = true; }
        Command::WebcamEffects(value) => { chain.set_webcam_params(value); repaint = true; }
        Command::Layout(value) => { chain.set_layout(value); repaint = true; }
        Command::Background(value) => { if chain.set_background(value).is_ok() { repaint = true; } }
        Command::Zoom(value) => {
          let track = ZoomTrack::new(value);
          shared.zoom_regions.store(track.len() as u64, Ordering::Release);
          chain.set_zoom_track(track); repaint = true;
        }
        Command::Cuts(value) => {
          let track = CutTrack::new(value);
          if track != cuts {
            cuts = track;
            shared.cut_count.store(cuts.len() as u64, Ordering::Release);
            let now = { let mut clock = lock(&shared.clock);
              clock.duration_ms = cuts.composition_duration(shared.source.duration_ms);
              clock.now_ms() };
            shared.generation.fetch_add(1, Ordering::AcqRel);
            shared.force_present.store(true, Ordering::Release);
            seek = Some((now, SeekMode::Exact));
          }
        }
        Command::Crop(value) => { chain.set_source_crop(value); repaint = true; }
        Command::WebcamLayout(value) => { chain.set_webcam_layout(value); repaint = true; }
        Command::CursorImage(value) => match chain.set_cursor_image(value) {
          Ok(()) => repaint = true,
          Err(error) => eprintln!("[engine] cursor bitmap rejected: {error}"),
        },
        Command::CursorImages(value) => {
          let count = value.len() as u64;
          match chain.set_cursor_images(value) {
            Ok(()) => { shared.cursor_images.store(count, Ordering::Release); repaint = true; }
            Err(error) => eprintln!("[engine] cursor bitmaps rejected: {error}"),
          }
        }
        Command::CursorTrack(value) => {
          let track = CursorTrack::new(value);
          shared.cursor_samples.store(track.len() as u64, Ordering::Release);
          chain.set_cursor_track(track); repaint = true;
        }
        Command::CursorStyle(size, opacity) => { chain.set_cursor_style(size, opacity); repaint = true; }
        Command::CursorEffects(value) => { chain.set_cursor_effects(value); repaint = true; }
        Command::WebcamCuts(value) => { chain.set_webcam_cuts(value); repaint = true; }
        Command::LayerOrder(value) => { chain.set_layer_order(value); repaint = true; }
        Command::WebcamZoom(value) => { chain.set_webcam_zoom_regions(WebcamZoomTrack::new(value)); repaint = true; }
        Command::Snapshot(reply) => snapshots.push(reply),
      }
    }
    if repaint { repaint_slots(&shared, &mut chain, &mut pool, &mut rgba); }
    for reply in snapshots {
      let current = *lock(&shared.current);
      let pixels = current.and_then(|frame| {
        // `read_rgba` gives the final composite. Convert exactly as presentation does.
        if chain.render_slot(frame.slot).is_err() || chain.read_rgba(&mut rgba).is_err() { return None; }
        let mut bgra = vec![0; rgba.len()];
        for (src, dst) in rgba.chunks_exact(4).zip(bgra.chunks_exact_mut(4)) {
          dst.copy_from_slice(&[src[2], src[1], src[0], src[3]]);
        }
        Some(bgra)
      });
      let _ = reply.send(pixels);
    }
    if let Some((target, mode)) = seek {
      latest_webcam_ms = f64::NEG_INFINITY;
      skipping_past = None;
      overlays.reset(&mut chain);
      do_seek(&shared, &mut decoder, &mut webcam, &mut overlays, &mut latest_webcam_ms,
        &mut chain, &mut pool, &cuts, &mut next_slot, target, mode, &mut rgba);
      continue;
    }
    if shared.eof.load(Ordering::Acquire) {
      std::thread::sleep(Duration::from_millis(5));
      continue;
    }
    {
      let queue = lock(&shared.frames);
      if queue.len() >= QUEUE_CAPACITY {
        let _wait = shared.space.wait_timeout(queue, Duration::from_millis(10));
        continue;
      }
    }
    let started = Instant::now();
    let frame = match decoder.next_frame() {
      Ok(Some(frame)) => frame,
      Ok(None) | Err(_) => { shared.eof.store(true, Ordering::Release); continue; }
    };
    if let Some(end) = cuts.cut_end_at(frame.pts_ms) {
      if skipping_past != Some(end) {
        skipping_past = Some(end);
        if decoder.seek_to_keyframe_before(end).is_err() { shared.eof.store(true, Ordering::Release); }
      }
      continue;
    }
    skipping_past = None;
    let source_ms = frame.pts_ms;
    let composition_ms = cuts.to_composition(source_ms);
    pull_webcam(&mut webcam, &mut overlays, &mut latest_webcam_ms, source_ms);
    let slot = next_slot;
    next_slot = (next_slot + 1) % pool.len();
    overlays.stage_webcam(&mut chain, slot);
    if frame.stage(&mut chain, slot).and_then(|()|
      render_frame(&mut chain, &mut pool, slot, composition_ms, &mut rgba)).is_err() {
      shared.skipped_render_error.fetch_add(1, Ordering::Relaxed);
      continue;
    }
    shared.decoded.fetch_add(1, Ordering::Relaxed);
    shared.decode_us_total.fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
    lock(&shared.frames).push_back(QueuedFrame {
      slot, pts_ms: composition_ms, generation: shared.generation.load(Ordering::Acquire),
    });
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use super::super::media::fixtures::{recording, recording_painted, recording_sized};

  #[test]
  fn clock_preserves_playhead_across_pause_rate_and_seek() {
    let mut clock = Clock { playing: false, rate: 1.0, anchor_media_ms: 100.0,
      anchor_at: Instant::now(), duration_ms: 1000.0 };
    assert!((clock.now_ms() - 100.0).abs() < 1.0);
    clock.set_playing(true);
    clock.anchor_at -= Duration::from_millis(100);
    assert!((clock.now_ms() - 200.0).abs() < 10.0);
    clock.set_rate(2.0);
    clock.anchor_at -= Duration::from_millis(100);
    assert!((clock.now_ms() - 400.0).abs() < 10.0);
    clock.set_playing(false);
    let held = clock.now_ms();
    assert!((held - clock.now_ms()).abs() < 1.0);
    clock.jump_to(800.0);
    assert!((clock.now_ms() - 800.0).abs() < 1.0);
  }

  #[test]
  fn queue_selects_latest_due_and_discards_stale_generation() {
    let frame = |slot, pts_ms, generation| QueuedFrame { slot, pts_ms, generation };
    let mut queue = VecDeque::from([frame(0, 0.0, 0), frame(1, 10.0, 1),
      frame(2, 20.0, 1), frame(3, 30.0, 1)]);
    let (chosen, dropped) = select_due(&mut queue, 25.0, 1, false, false);
    assert_eq!(chosen, Some(frame(2, 20.0, 1)));
    assert_eq!(dropped, 1);
    assert_eq!(queue.len(), 1);
    let (chosen, _) = select_due(&mut queue, 0.0, 1, true, false);
    assert_eq!(chosen, Some(frame(3, 30.0, 1)));
  }

  #[test]
  #[ignore = "requires a GBM render node and a wgpu adapter"]
  fn playback_and_exact_seek_on_hardware() {
    let fixture = recording(false);
    let player = Player::open(fixture.0.to_str().unwrap()).unwrap();
    player.set_playing(true);
    let started = Instant::now();
    let mut pts = Vec::new();
    while started.elapsed() < Duration::from_millis(500) {
      if let Some(frame) = player.tick() {
        assert!(player.texture_info(frame).dmabuf_fd.is_some());
        pts.push(frame.pts_ms);
      }
      std::thread::sleep(Duration::from_millis(8));
    }
    assert!(pts.len() >= 3, "presented {pts:?}");
    assert!(pts.windows(2).all(|pair| pair[0] < pair[1]));
    player.seek(0.0, SeekMode::Exact);
    let started = Instant::now();
    loop {
      if let Some(frame) = player.tick() { assert!(frame.pts_ms.abs() < 40.0); break; }
      assert!(started.elapsed() < Duration::from_secs(2));
      std::thread::sleep(Duration::from_millis(8));
    }
  }

  /// Waits for the next presented frame, failing after two seconds.
  fn next_presented(player: &Player) -> QueuedFrame {
    let started = Instant::now();
    loop {
      if let Some(frame) = player.tick() { return frame; }
      assert!(started.elapsed() < Duration::from_secs(2), "no frame presented");
      std::thread::sleep(Duration::from_millis(8));
    }
  }

  #[test]
  #[ignore = "requires a GBM render node and a wgpu adapter"]
  fn a_picture_that_is_not_macroblock_aligned_still_renders() {
    // 40 rows pads to 48 in the bitstream, and OpenH264 hands back 40. A chain
    // sized to the padded height rejects every frame, as 1080p did.
    let fixture = recording_sized(false, 64, 40);
    let player = Player::open(fixture.0.to_str().unwrap()).unwrap();
    player.seek(0.0, SeekMode::Exact);
    next_presented(&player);
    assert_eq!(player.stats().skipped_render_error, 0);
  }

  #[test]
  #[ignore = "requires a GBM render node and a wgpu adapter"]
  fn the_camera_sidecar_is_drawn_into_the_frame() {
    use crate::engine::layout::Rect;
    let screen = recording(false);
    let white = [255, 255, 255, 0];
    let camera = recording_painted(false, 32, 24, [white; 3]);
    let player = Player::open_with_webcam(screen.0.to_str().unwrap(),
      Some(camera.0.to_str().unwrap()), None).unwrap();
    assert!(player.has_webcam());
    let centre = |bgra: &[u8]| { let i = (24 * 64 + 32) * 4; [bgra[i], bgra[i + 1], bgra[i + 2]] };
    let corner = |bgra: &[u8]| [bgra[0], bgra[1], bgra[2]];
    player.set_webcam_layout(WebcamLayout {
      rect: Rect { x: 16.0, y: 12.0, width: 32.0, height: 24.0 }, ..WebcamLayout::default()
    });
    player.seek(0.0, SeekMode::Exact);
    next_presented(&player);
    let frame = player.snapshot_bgra().unwrap();
    assert!(centre(&frame).iter().all(|&c| c > 240), "camera box {:?}", centre(&frame));
    assert!(corner(&frame)[2] > 150 && corner(&frame)[1] < 100, "screen corner {:?}", corner(&frame));
    // After a seek the camera is staged again, not left blank.
    player.seek(1500.0, SeekMode::Exact);
    next_presented(&player);
    let frame = player.snapshot_bgra().unwrap();
    assert!(centre(&frame).iter().all(|&c| c > 240), "camera box after seek {:?}", centre(&frame));
    assert!(corner(&frame)[1] > 150, "screen corner after seek {:?}", corner(&frame));
    assert_eq!(player.stats().skipped_render_error, 0);
  }

}
