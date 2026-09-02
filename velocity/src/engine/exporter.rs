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

use crate::engine::decode::Decoder;
use crate::engine::encode::Encoder;
use crate::engine::render::{EffectParams, RenderChain};

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

  let width = decoder.display_width;
  let height = decoder.display_height;
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
  let mut chain = RenderChain::new(width, height, 1)?;
  chain.set_params(options.effects);

  stage("create encoder");

  let mut encoder = Encoder::create(
    &options.output,
    width,
    height,
    decoder.fps_num,
    decoder.fps_den,
    options.bitrate,
  )?;

  // Media Foundation seeks to a keyframe, so skip the pre-roll frames by pts
  // rather than trusting the seek to land exactly.
  if options.start_ms > 0.0 {
    stage("seek");
    decoder.seek((options.start_ms * 10_000.0) as i64)?;
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

    let source = sample
      .texture
      .as_ref()
      .expect("non-eos sample must carry a texture");

    stage("render");
    let t_render = Instant::now();
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
