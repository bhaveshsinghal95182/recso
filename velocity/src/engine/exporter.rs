//! Export: decode a range of a file, encode it, mux to MP4.
//!
//! Runs on its own thread and reports progress, because an export of anything
//! real takes minutes and must not block the UI or the player.
//!
//! This is deliberately *not* the player. Export runs as fast as the hardware
//! allows with no clock, no lookahead queue, and no frame dropping — every
//! source frame must appear in the output exactly once.
//!
//! It gets its own `Decoder`, so exporting while previewing works: a Media
//! Foundation source reader is single-consumer, and two readers on one file are
//! cheaper than trying to share one.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use windows::core::Result;

use crate::engine::composite::{CursorSample, CursorTrack, SpriteTexture, WebcamLayout};
use crate::engine::cuts::{Cut, CutTrack};
use crate::engine::decode::Decoder;
use crate::engine::encode::Encoder;
use crate::engine::player::{advance_webcam, CursorImage, WebcamSync};
use crate::engine::render::{Background, BackgroundRequest, EffectParams, RenderChain, VideoLayout};
use crate::engine::zoom::{ZoomRegion, ZoomTrack};

pub struct Options {
  pub input: String,
  pub output: String,
  pub bitrate: u32,
  pub start_ms: f64,
  /// Zero or negative means "to the end of the file".
  pub end_ms: f64,
  /// Must match what the preview is showing, or the export is not what the
  /// user approved. The caller is responsible for passing the live values.
  pub effects: EffectParams,
  /// The canvas to compose onto. `None` is the recording's own visible size.
  pub canvas: Option<(u32, u32)>,
  /// Where the recording sits on that canvas. `None` fills it.
  pub layout: Option<VideoLayout>,
  /// What is behind the video. Only visible if `layout` insets it. Uploaded on
  /// the export thread, like the cursor bitmap beside it.
  pub background: Option<BackgroundRequest>,
  /// The webcam's own grade, separate from the video's.
  pub webcam_effects: EffectParams,
  /// The camera sidecar, if the recording has one.
  ///
  /// The exporter opens its own decoder for it, the same way it opens its own
  /// decoder for the screen track: a Media Foundation source reader has one
  /// consumer, so sharing the player's would mean the preview and the export
  /// fighting over the read position.
  pub webcam_path: Option<String>,
  /// Where the camera goes. `None` leaves the overlay out.
  pub webcam_layout: Option<WebcamLayout>,
  /// The pointer bitmap. `None` leaves the cursor out.
  pub cursor_image: Option<CursorImage>,
  pub cursor_track: Vec<CursorSample>,
  /// Cursor height in destination pixels, and its opacity.
  pub cursor_size: f32,
  pub cursor_opacity: f32,
  /// The zoom/pan timeline. Empty exports unzoomed.
  pub zoom_regions: Vec<ZoomRegion>,
  /// Spans of the *source* to leave out. Empty exports the whole range.
  pub cuts: Vec<Cut>,
}

pub struct Shared {
  cancel: AtomicBool,
  frames_done: AtomicU64,
  frames_total: AtomicU64,
  decode_us: AtomicU64,
  encode_us: AtomicU64,
  render_us: AtomicU64,
  finished: AtomicBool,
  started_at: Instant,
  elapsed_us: AtomicU64,
  /// Elapsed time when the first frame landed.
  ///
  /// Opening the decoder, compiling shaders and spinning up the encoder all
  /// happen before any frame does, and on a discrete GPU that setup is slower.
  /// Folding it into an average fps makes a fast encoder look slow on short
  /// clips, so it is reported separately.
  setup_us: AtomicU64,
  error: Mutex<Option<String>>,
  /// Which call we are inside. An HRESULT on its own does not say whether the
  /// decode, the render or the encode rejected it.
  stage: Mutex<&'static str>,
}

pub struct Progress {
  pub frames_done: u64,
  pub frames_total: u64,
  pub finished: bool,
  pub cancelled: bool,
  pub error: Option<String>,
  pub fps: f64,
  /// Frames per second once encoding is actually running, setup excluded.
  pub steady_fps: f64,
  pub setup_ms: f64,
  pub avg_decode_ms: f64,
  pub avg_render_ms: f64,
  pub avg_encode_ms: f64,
  pub elapsed_ms: f64,
}

pub struct Exporter {
  shared: Arc<Shared>,
  thread: Option<JoinHandle<()>>,
}

impl Exporter {
  pub fn start(options: Options) -> Self {
    let shared = Arc::new(Shared {
      cancel: AtomicBool::new(false),
      frames_done: AtomicU64::new(0),
      frames_total: AtomicU64::new(0),
      decode_us: AtomicU64::new(0),
      encode_us: AtomicU64::new(0),
      render_us: AtomicU64::new(0),
      finished: AtomicBool::new(false),
      started_at: Instant::now(),
      elapsed_us: AtomicU64::new(0),
      setup_us: AtomicU64::new(0),
      error: Mutex::new(None),
      stage: Mutex::new("init"),
    });

    let thread_shared = Arc::clone(&shared);
    let thread = std::thread::Builder::new()
      .name("export".into())
      .spawn(move || {
        if let Err(e) = run(&thread_shared, options) {
          let stage = *thread_shared.stage.lock().unwrap();
          *thread_shared.error.lock().unwrap() = Some(format!(
            "[{}] {} (hr=0x{:08X})",
            stage,
            e.message(),
            e.code().0 as u32
          ));
        }
        thread_shared
          .elapsed_us
          .store(thread_shared.started_at.elapsed().as_micros() as u64, Ordering::Relaxed);
        thread_shared.finished.store(true, Ordering::Release);
      })
      .expect("spawn export thread");

    Self {
      shared,
      thread: Some(thread),
    }
  }

  pub fn cancel(&self) {
    self.shared.cancel.store(true, Ordering::Release);
  }

  pub fn progress(&self) -> Progress {
    let done = self.shared.frames_done.load(Ordering::Relaxed);
    let finished = self.shared.finished.load(Ordering::Acquire);

    // While running, read the live clock; once finished, the frozen total.
    let elapsed_us = if finished {
      self.shared.elapsed_us.load(Ordering::Relaxed)
    } else {
      self.shared.started_at.elapsed().as_micros() as u64
    };
    let elapsed_ms = elapsed_us as f64 / 1000.0;

    let per = |total: &AtomicU64| {
      if done == 0 {
        0.0
      } else {
        total.load(Ordering::Relaxed) as f64 / done as f64 / 1000.0
      }
    };

    Progress {
      frames_done: done,
      frames_total: self.shared.frames_total.load(Ordering::Relaxed),
      finished,
      cancelled: self.shared.cancel.load(Ordering::Acquire),
      error: self.shared.error.lock().unwrap().clone(),
      fps: if elapsed_ms > 0.0 {
        done as f64 / (elapsed_ms / 1000.0)
      } else {
        0.0
      },
      steady_fps: {
        let setup_ms = self.shared.setup_us.load(Ordering::Relaxed) as f64 / 1000.0;
        let running_ms = elapsed_ms - setup_ms;
        if done > 1 && running_ms > 0.0 {
          (done - 1) as f64 / (running_ms / 1000.0)
        } else {
          0.0
        }
      },
      setup_ms: self.shared.setup_us.load(Ordering::Relaxed) as f64 / 1000.0,
      avg_decode_ms: per(&self.shared.decode_us),
      avg_render_ms: per(&self.shared.render_us),
      avg_encode_ms: per(&self.shared.encode_us),
      elapsed_ms,
    }
  }

  pub fn join(&mut self) {
    if let Some(t) = self.thread.take() {
      let _ = t.join();
    }
  }
}

impl Drop for Exporter {
  fn drop(&mut self) {
    self.cancel();
    self.join();
  }
}

fn run(shared: &Arc<Shared>, options: Options) -> Result<()> {
  let stage = |name: &'static str| *shared.stage.lock().unwrap() = name;

  stage("open input");
  let mut decoder = Decoder::open(&options.input)?;

  // Same tolerance as the player: a camera sidecar that will not open costs the
  // overlay, not the export. Refusing to write the file at all would be worse.
  stage("open webcam");
  let mut webcam = options
    .webcam_path
    .as_deref()
    .and_then(|path| match Decoder::open(path) {
      Ok(decoder) => Some(decoder),
      Err(error) => {
        eprintln!("[engine] export webcam sidecar {path} did not open: {error:?}");
        None
      }
    });

  let fps = decoder.fps_num as f64 / decoder.fps_den.max(1) as f64;

  let end_ms = if options.end_ms > 0.0 {
    options.end_ms.min(decoder.duration_100ns as f64 / 10_000.0)
  } else {
    decoder.duration_100ns as f64 / 10_000.0
  };
  let span_ms = (end_ms - options.start_ms).max(0.0);
  shared
    .frames_total
    .store((span_ms / 1000.0 * fps).round() as u64, Ordering::Relaxed);

  // The render layer sits here, between decode and the fork. Export and preview
  // run the same chain, so what you see is what lands in the file.
  stage("create render chain");
  // One slot: export never needs to re-render a frame it has already written.
  let mut chain = RenderChain::new(
    decoder.coded_size(),
    decoder.display_size(),
    options.canvas.unwrap_or_else(|| decoder.display_size()),
    1,
  )?;
  chain.set_params(options.effects);
  chain.set_webcam_params(options.webcam_effects);
  if let Some(layout) = options.layout {
    chain.set_layout(layout);
  }
  if let Some(request) = options.background {
    stage("upload background");
    chain.set_background(Background::build(request)?);
  }

  // Every layer the player has, or the engine's central claim -- preview and
  // export cannot drift, because they are the same chain -- is only true for
  // the grading pass and quietly false for the two the user can see moving.
  if let Some(webcam) = webcam.as_ref() {
    stage("attach webcam");
    let (webcam_width, webcam_height) = webcam.coded_size();
    chain.attach_webcam(webcam_width, webcam_height)?;
  }
  if let Some(layout) = options.webcam_layout {
    chain.set_webcam_layout(layout);
  }

  if let Some(image) = options.cursor_image.as_ref() {
    stage("upload cursor");
    chain.set_cursor_image(Some(SpriteTexture::new(
      image.width,
      image.height,
      &image.pixels,
      image.hotspot_x,
      image.hotspot_y,
    )?));
  }
  chain.set_cursor_track(CursorTrack::new(options.cursor_track));
  chain.set_cursor_style(options.cursor_size, options.cursor_opacity);
  chain.set_zoom_track(ZoomTrack::new(options.zoom_regions));
  let cuts = CutTrack::new(options.cuts);

  stage("create encoder");

  // From the chain, not the decoder: the chain crops the macroblock padding off
  // on the way to NV12, so its output is what the sink writer has to be told
  // about. Handing it the decoder's frame size would describe a texture two to
  // eight rows taller than the one it is actually given.
  let (out_width, out_height) = chain.output_size();
  let mut encoder = Encoder::create(
    &options.output,
    out_width,
    out_height,
    decoder.fps_num,
    decoder.fps_den,
    options.bitrate,
  )?;

  let mut webcam_sync = WebcamSync::default();

  // Media Foundation seeks to a keyframe, so skip the pre-roll frames by pts
  // rather than trusting the seek to land exactly.
  if options.start_ms > 0.0 {
    stage("seek");
    decoder.seek((options.start_ms * 10_000.0) as i64)?;
    // The camera has to move with it. Left where it was, the overlay would
    // start the export showing whatever the camera was doing at t=0 and catch
    // up over the following seconds.
    if let Some(webcam) = webcam.as_mut() {
      webcam.seek((options.start_ms * 10_000.0) as i64)?;
    }
  }

  loop {
    if shared.cancel.load(Ordering::Acquire) {
      break;
    }

    stage("read_sample");
    let t_decode = Instant::now();
    let sample = decoder.read_sample()?;
    if sample.end_of_stream {
      break;
    }
    let decode_us = t_decode.elapsed().as_micros() as u64;

    let pts_ms = sample.timestamp_100ns as f64 / 10_000.0;
    if pts_ms + 0.5 < options.start_ms {
      continue; // still in the keyframe pre-roll
    }
    if pts_ms > end_ms {
      break;
    }
    // Cut frames are simply never written. The encoder timestamps from its own
    // frame counter, so skipping one closes the gap in the output rather than
    // leaving a hole -- which is exactly what a cut means.
    //
    // No seek past the cut here, unlike the player: export is not racing a
    // clock, and decode is the cheapest stage in the loop. Seeking would cost a
    // GOP of re-decode to save a few frames of it.
    if cuts.contains(pts_ms) {
      continue;
    }

    // Everything downstream runs on composition time: the cursor track and the
    // zoom timeline are authored against the edit, not against the file.
    let composition_ms = cuts.to_composition(pts_ms);

    let source = sample
      .texture
      .as_ref()
      .expect("non-eos sample must carry a texture");

    stage("render");
    let t_render = Instant::now();

    // One slot, so there is no previous slot to inherit from -- and none is
    // needed: with a single slot the last camera frame simply stays staged
    // until a newer one replaces it, which is the carry-forward behaviour the
    // player gets from `inherit_webcam`.
    advance_webcam(&mut chain, &mut webcam, &mut webcam_sync, None, 0, pts_ms);
    // Resolved against this frame's own pts, not a playhead, so a cursor in the
    // file lands where it landed on screen.
    chain.stage_timeline(0, composition_ms);

    // Clone the COM reference so the borrow on the chain ends before the
    // encoder call; it is a refcount bump, not a copy.
    let encoded = chain.process_to_nv12(source, sample.subresource)?.clone();
    let render_us = t_render.elapsed().as_micros() as u64;

    stage("encode write_texture");
    let t_encode = Instant::now();
    encoder.write_texture(&encoded, 0)?;
    let encode_us = t_encode.elapsed().as_micros() as u64;

    shared.decode_us.fetch_add(decode_us, Ordering::Relaxed);
    shared.render_us.fetch_add(render_us, Ordering::Relaxed);
    shared.encode_us.fetch_add(encode_us, Ordering::Relaxed);
    if shared.frames_done.fetch_add(1, Ordering::Relaxed) == 0 {
      shared
        .setup_us
        .store(shared.started_at.elapsed().as_micros() as u64, Ordering::Relaxed);
    }
  }

  // Always finalise, even on cancel: an MP4 without its moov atom is unplayable
  // and a half-written file is more use than a corrupt one.
  stage("finalize");
  encoder.finish()?;
  Ok(())
}
