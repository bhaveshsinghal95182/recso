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

use crate::engine::audio::{AudioMixer, MIX_SAMPLE_RATE};
use crate::engine::composite::{
  CursorImages, CursorSample, CursorTrack, SpriteTexture, WebcamLayout,
};
use crate::engine::cuts::{Cut, CutTrack};
use crate::engine::decode::Decoder;
use crate::engine::encode::{AudioSpec, Encoder};
use crate::engine::player::{advance_webcam, CursorImage, WebcamSync};
use crate::engine::render::{
  Background, BackgroundRequest, CursorEffects, EffectParams, RenderChain, SourceCrop, VideoLayout,
};
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
  ///
  /// Drawn for any sample that does not name one of `cursor_images`, so a
  /// recording with a full bitmap table never reaches it.
  pub cursor_image: Option<CursorImage>,
  /// The distinct pointer bitmaps the recording used, indexed by each
  /// sample's `image_id`.
  pub cursor_images: Vec<CursorImage>,
  pub cursor_track: Vec<CursorSample>,
  /// Cursor height in destination pixels, and its opacity.
  pub cursor_size: f32,
  pub cursor_opacity: f32,
  pub cursor_effects: CursorEffects,
  /// Spans of the composition to leave the camera out of.
  pub webcam_cuts: Vec<(f64, f64)>,
  /// The zoom/pan timeline. Empty exports unzoomed.
  pub zoom_regions: Vec<ZoomRegion>,
  /// Every file contributing sound, with the offset that puts it on the screen
  /// recording's clock. Empty exports silent.
  ///
  /// The screen recording and the camera sidecar are not added automatically:
  /// which tracks belong in the mix is an editing decision, and a caller that
  /// wants the camera muted should be able to say so by leaving it out.
  pub audio_sources: Vec<(String, f64)>,
  /// Spans of the *source* to leave out. Empty exports the whole range.
  pub cuts: Vec<Cut>,
  /// Edges of the recording to throw away. `None` keeps all of it.
  pub crop: Option<SourceCrop>,
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
        thread_shared.elapsed_us.store(
          thread_shared.started_at.elapsed().as_micros() as u64,
          Ordering::Relaxed,
        );
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
      // Never less than what has actually been written. The total is estimated
      // from the range and the frame rate, so a file whose real rate differs
      // slightly can overshoot it -- and a progress bar reading 104% is a
      // worse lie than one that sits at 100 for a moment.
      frames_total: self.shared.frames_total.load(Ordering::Relaxed).max(done),
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

/// How many audio frames should have been written by `composition_ms`.
///
/// Derived from the position rather than accumulated per video frame: a
/// variable-rate screen recording has no fixed frames-per-video-frame, and
/// rounding one every frame would drift the audio against the picture over a
/// long export.
fn audio_frames_due(composition_ms: f64, already_written: u64) -> usize {
  let target = (composition_ms.max(0.0) / 1000.0 * MIX_SAMPLE_RATE as f64).round() as u64;
  target.saturating_sub(already_written) as usize
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
  let cuts = CutTrack::new(options.cuts);

  let end_ms = if options.end_ms > 0.0 {
    options.end_ms.min(decoder.duration_100ns as f64 / 10_000.0)
  } else {
    decoder.duration_100ns as f64 / 10_000.0
  };

  // The *edit's* span, not the file's. Cut frames are never written, so
  // counting them leaves `frames_done` short of `frames_total` by exactly the
  // cut fraction -- an export that finishes correctly while its progress bar
  // stops at 75% and never moves again.
  let span_ms = (cuts.to_composition(end_ms) - cuts.to_composition(options.start_ms)).max(0.0);
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
  if !options.cursor_images.is_empty() {
    stage("upload cursor bitmaps");
    // Fallible here, unlike in the player: an export runs once and is kept, so
    // a pointer silently falling back to the wrong shape for its whole length
    // is worse than refusing to start.
    let mut uploaded = Vec::with_capacity(options.cursor_images.len());
    for image in &options.cursor_images {
      uploaded.push(SpriteTexture::new(
        image.width,
        image.height,
        &image.pixels,
        image.hotspot_x,
        image.hotspot_y,
      )?);
    }
    chain.set_cursor_images(CursorImages::new(uploaded));
  }
  chain.set_cursor_track(CursorTrack::new(options.cursor_track));
  chain.set_cursor_style(options.cursor_size, options.cursor_opacity);
  chain.set_cursor_effects(options.cursor_effects);
  chain.set_webcam_cuts(options.webcam_cuts);
  chain.set_zoom_track(ZoomTrack::new(options.zoom_regions));
  chain.set_source_crop(options.crop);

  // ---- audio ---------------------------------------------------------------
  //
  // Opened before the encoder, because whether there is an audio stream at all
  // decides how the encoder is created: `BeginWriting` fixes the set of
  // streams, so a track cannot be added once writing has begun.
  stage("open audio");
  let mut mixer = AudioMixer::open(&options.audio_sources, cuts.clone())?;

  // Where this export begins on the edit's timeline. Audio is written relative
  // to it, not to the file's zero: an export trimmed to start a minute in wants
  // the sound from a minute in, and measuring from zero would play the opening
  // minute of audio under the wrong picture.
  let export_origin_ms = cuts.to_composition(options.start_ms.max(0.0));
  if let Some(mixer) = mixer.as_mut() {
    mixer.skip_to(export_origin_ms)?;
  }
  if let Some(mixer) = mixer.as_ref() {
    eprintln!(
      "[engine] export mixing {} audio source(s)",
      mixer.source_count()
    );
  }

  stage("create encoder");

  // From the chain, not the decoder: the chain crops the macroblock padding off
  // on the way to NV12, so its output is what the sink writer has to be told
  // about. Handing it the decoder's frame size would describe a texture two to
  // eight rows taller than the one it is actually given.
  let (out_width, out_height) = chain.output_size();
  let mut encoder = Encoder::create_with_audio(
    &options.output,
    out_width,
    out_height,
    decoder.fps_num,
    decoder.fps_den,
    options.bitrate,
    mixer.as_ref().map(|_| AudioSpec::default()),
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

  // Frames of audio handed to the encoder so far. Counted rather than derived
  // from a clock so the audio timeline advances by exactly what was written.
  let mut audio_frames_written = 0u64;
  let mut last_composition_ms = 0.0f64;

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
    last_composition_ms = composition_ms;

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

    // Audio is written to keep pace with the picture rather than in one block
    // at the end. The sink writer buffers whatever it has not been able to
    // interleave yet, so handing it an entire soundtrack after the last frame
    // would hold the whole thing in memory -- the exact thing the windowed
    // mixer exists to avoid.
    if let Some(mixer) = mixer.as_mut() {
      stage("write audio");
      let due = audio_frames_due(composition_ms - export_origin_ms, audio_frames_written);
      if due > 0 {
        encoder.write_audio(&mixer.next_window(due))?;
        audio_frames_written += due as u64;
      }
    }

    shared.decode_us.fetch_add(decode_us, Ordering::Relaxed);
    shared.render_us.fetch_add(render_us, Ordering::Relaxed);
    shared.encode_us.fetch_add(encode_us, Ordering::Relaxed);
    if shared.frames_done.fetch_add(1, Ordering::Relaxed) == 0 {
      shared.setup_us.store(
        shared.started_at.elapsed().as_micros() as u64,
        Ordering::Relaxed,
      );
    }
  }

  // The last video frame is displayed for its own duration, and audio under it
  // has to reach the end of that rather than stopping at the frame's timestamp.
  // Without this the sound ends a frame early, which on a clip that finishes on
  // a word is very noticeable.
  if let Some(mixer) = mixer.as_mut() {
    stage("flush audio");
    let frame_ms = 1000.0 / fps.max(1.0);
    let due = audio_frames_due(
      last_composition_ms + frame_ms - export_origin_ms,
      audio_frames_written,
    );
    if due > 0 {
      encoder.write_audio(&mixer.next_window(due))?;
    }
  }

  // Audio and video should come out the same length. They are produced by
  // different clocks -- one counts samples, the other follows frame
  // timestamps -- so a disagreement here means one of them drifted, which is
  // audible as lip sync long before it is visible in a duration.
  if mixer.is_some() {
    let audio_ms = encoder.audio_frames_written() as f64 / MIX_SAMPLE_RATE as f64 * 1000.0;
    let drift = audio_ms - (last_composition_ms - export_origin_ms);
    if drift.abs() > 50.0 {
      eprintln!(
        "[engine] export audio is {drift:.0}ms out against the picture          (audio {audio_ms:.0}ms, video {last_composition_ms:.0}ms)"
      );
    }
  }

  // Always finalise, even on cancel: an MP4 without its moov atom is unplayable
  // and a half-written file is more use than a corrupt one.
  stage("finalize");
  encoder.finish()?;
  Ok(())
}
