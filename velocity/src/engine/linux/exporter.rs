//! Linux export: decode every kept source frame, render it, and mux an MP4.
//!
//! A dedicated thread runs without a playback clock. Unlike Windows' GPU
//! encoder path, wgpu readback feeds the software H.264 recorder, while the
//! shared audio mixer feeds 20 ms Opus packets. Once opened, the MP4 is always
//! finalised, including after cancellation or a frame error.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use crate::capture::linux::audio::{OpusEncoder, PACKET_FRAMES};
use crate::capture::linux::encoder::{AudioSettings, Mp4Recorder, PixelOrder, VideoSettings};
use crate::engine::cuts::{Cut, CutTrack};
use crate::engine::layout::{CursorSample, CursorTrack, WebcamLayout};
use crate::engine::mix::{audio_frames_due, AudioMixer, MIX_CHANNELS, MIX_SAMPLE_RATE};
use crate::engine::scene::{BackgroundRequest, CursorEffects, EffectParams, Layer, SourceCrop, VideoLayout};
use crate::engine::zoom::{WebcamZoomRegion, WebcamZoomTrack, ZoomRegion, ZoomTrack};
use super::audio::OpusSource;
use super::player::{pull_webcam, CursorImage, OverlayState, PlaneSource};
use super::render::RenderChain;

pub(crate) struct Options {
  pub input: String,
  pub output: String,
  pub bitrate: u32,
  pub start_ms: f64,
  pub end_ms: f64,
  pub effects: EffectParams,
  pub webcam_effects: EffectParams,
  pub canvas: Option<(u32, u32)>,
  pub layout: Option<VideoLayout>,
  pub background: Option<BackgroundRequest>,
  pub webcam_path: Option<String>,
  pub webcam_layout: Option<WebcamLayout>,
  pub cursor_image: Option<CursorImage>,
  pub cursor_images: Vec<CursorImage>,
  pub cursor_track: Vec<CursorSample>,
  pub cursor_size: f32,
  pub cursor_opacity: f32,
  pub cursor_effects: CursorEffects,
  pub webcam_cuts: Vec<(f64, f64)>,
  pub layer_order: [Layer; 3],
  pub webcam_zoom_regions: Vec<WebcamZoomRegion>,
  pub zoom_regions: Vec<ZoomRegion>,
  pub audio_sources: Vec<(String, f64)>,
  pub cuts: Vec<Cut>,
  pub crop: Option<SourceCrop>,
}

struct Shared {
  cancel: AtomicBool,
  frames_done: AtomicU64,
  frames_total: AtomicU64,
  decode_us: AtomicU64,
  render_us: AtomicU64,
  encode_us: AtomicU64,
  finished: AtomicBool,
  started_at: Instant,
  elapsed_us: AtomicU64,
  setup_us: AtomicU64,
  error: Mutex<Option<String>>,
  stage: Mutex<&'static str>,
}

pub(crate) struct Progress {
  pub frames_done: u64,
  pub frames_total: u64,
  pub finished: bool,
  pub cancelled: bool,
  pub error: Option<String>,
  pub fps: f64,
  pub steady_fps: f64,
  pub setup_ms: f64,
  pub avg_decode_ms: f64,
  pub avg_render_ms: f64,
  pub avg_encode_ms: f64,
  pub elapsed_ms: f64,
}

pub(crate) struct Exporter {
  shared: Arc<Shared>,
  thread: Option<JoinHandle<()>>,
}
impl Exporter {
  pub(crate) fn start(options: Options) -> Self {
    let shared = Arc::new(Shared {
      cancel: AtomicBool::new(false), frames_done: AtomicU64::new(0),
      frames_total: AtomicU64::new(0), decode_us: AtomicU64::new(0),
      render_us: AtomicU64::new(0), encode_us: AtomicU64::new(0),
      finished: AtomicBool::new(false), started_at: Instant::now(),
      elapsed_us: AtomicU64::new(0), setup_us: AtomicU64::new(0),
      error: Mutex::new(None), stage: Mutex::new("init"),
    });
    let worker = Arc::clone(&shared);
    let thread = std::thread::Builder::new().name("export".into()).spawn(move || {
      if let Err(error) = run(&worker, options) {
        let stage = *worker.stage.lock().unwrap_or_else(|e| e.into_inner());
        *worker.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("[{stage}] {error}"));
      }
      worker.elapsed_us.store(worker.started_at.elapsed().as_micros() as u64, Ordering::Relaxed);
      worker.finished.store(true, Ordering::Release);
    });
    match thread {
      Ok(thread) => Self { shared, thread: Some(thread) },
      Err(error) => {
        *shared.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("[init] spawn export thread: {error}"));
        shared.finished.store(true, Ordering::Release);
        Self { shared, thread: None }
      }
    }
  }
  pub(crate) fn cancel(&self) { self.shared.cancel.store(true, Ordering::Release); }
  pub(crate) fn progress(&self) -> Progress {
    let done = self.shared.frames_done.load(Ordering::Relaxed);
    let finished = self.shared.finished.load(Ordering::Acquire);
    let elapsed_us = if finished { self.shared.elapsed_us.load(Ordering::Relaxed) }
      else { self.shared.started_at.elapsed().as_micros() as u64 };
    let elapsed_ms = elapsed_us as f64 / 1000.0;
    let per = |counter: &AtomicU64| if done == 0 { 0.0 }
      else { counter.load(Ordering::Relaxed) as f64 / done as f64 / 1000.0 };
    let setup_ms = self.shared.setup_us.load(Ordering::Relaxed) as f64 / 1000.0;
    let running_ms = elapsed_ms - setup_ms;
    Progress {
      frames_done: done,
      frames_total: self.shared.frames_total.load(Ordering::Relaxed).max(done),
      finished, cancelled: self.shared.cancel.load(Ordering::Acquire),
      error: self.shared.error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
      fps: if elapsed_ms > 0.0 { done as f64 / (elapsed_ms / 1000.0) } else { 0.0 },
      steady_fps: if done > 1 && running_ms > 0.0 {
        (done - 1) as f64 / (running_ms / 1000.0)
      } else { 0.0 },
      setup_ms, avg_decode_ms: per(&self.shared.decode_us),
      avg_render_ms: per(&self.shared.render_us), avg_encode_ms: per(&self.shared.encode_us), elapsed_ms,
    }
  }
}
impl Drop for Exporter {
  fn drop(&mut self) {
    self.cancel();
    if let Some(thread) = self.thread.take() { let _ = thread.join(); }
  }
}

fn set_stage(shared: &Shared, name: &'static str) {
  *shared.stage.lock().unwrap_or_else(|e| e.into_inner()) = name;
}

fn write_packets(recorder: &mut Mp4Recorder, encoder: &OpusEncoder,
  pending: &mut Vec<f32>, packets_written: &mut u64) -> Result<(), String> {
  let packet_samples = PACKET_FRAMES * MIX_CHANNELS as usize;
  while pending.len() >= packet_samples {
    let mut pcm = [0.0; PACKET_FRAMES * 2];
    pcm.copy_from_slice(&pending[..packet_samples]);
    pending.drain(..packet_samples);
    let packet = encoder.encode(&pcm)?;
    let pts = *packets_written as i64 * PACKET_FRAMES as i64 * 10_000_000 / MIX_SAMPLE_RATE as i64;
    recorder.push_audio_packet(&packet, pts)?;
    *packets_written += 1;
  }
  Ok(())
}

fn run(shared: &Shared, options: Options) -> Result<(), String> {
  set_stage(shared, "open input");
  let mut source = PlaneSource::open(&options.input)?;
  set_stage(shared, "open webcam");
  let mut webcam = options.webcam_path.as_deref().and_then(|path| match PlaneSource::open(path) {
    Ok(camera) => Some(camera),
    Err(error) => { eprintln!("[engine] export webcam sidecar {path} did not open: {error}"); None }
  });
  let fps = source.info.fps.max(1.0);
  let cuts = CutTrack::new(options.cuts);
  let end_ms = if options.end_ms > 0.0 { options.end_ms.min(source.info.duration_ms) }
    else { source.info.duration_ms };
  let span = (cuts.to_composition(end_ms) - cuts.to_composition(options.start_ms)).max(0.0);
  shared.frames_total.store((span * fps / 1000.0).round() as u64, Ordering::Relaxed);

  set_stage(shared, "create render chain");
  let size = (source.info.width, source.info.height);
  let canvas = options.canvas.unwrap_or(size);
  let mut chain = RenderChain::new(size, size, (canvas.0 & !1, canvas.1 & !1), 1)?;
  chain.set_params(options.effects);
  chain.set_webcam_params(options.webcam_effects);
  if let Some(layout) = options.layout { chain.set_layout(layout); }
  if let Some(background) = options.background {
    set_stage(shared, "upload background");
    chain.set_background(background)?;
  }
  if let Some(camera) = webcam.as_ref() {
    set_stage(shared, "attach webcam");
    chain.attach_webcam(camera.info.width, camera.info.height)?;
  }
  if let Some(layout) = options.webcam_layout { chain.set_webcam_layout(layout); }
  if options.cursor_image.is_some() {
    set_stage(shared, "upload cursor");
    chain.set_cursor_image(options.cursor_image)?;
  }
  if !options.cursor_images.is_empty() {
    set_stage(shared, "upload cursor bitmaps");
    chain.set_cursor_images(options.cursor_images)?;
  }
  chain.set_cursor_track(CursorTrack::new(options.cursor_track));
  chain.set_cursor_style(options.cursor_size, options.cursor_opacity);
  chain.set_cursor_effects(options.cursor_effects);
  chain.set_webcam_cuts(options.webcam_cuts);
  chain.set_layer_order(options.layer_order);
  chain.set_webcam_zoom_regions(WebcamZoomTrack::new(options.webcam_zoom_regions));
  chain.set_zoom_track(ZoomTrack::new(options.zoom_regions));
  chain.set_source_crop(options.crop);

  set_stage(shared, "open audio");
  let mut mixer = AudioMixer::open_with(&options.audio_sources, cuts.clone(), OpusSource::open);
  let origin_ms = cuts.to_composition(options.start_ms.max(0.0));
  if let Some(mixer) = mixer.as_mut() { mixer.skip_to(origin_ms); }
  let opus = if mixer.is_some() { Some(OpusEncoder::new()?) } else { None };
  set_stage(shared, "create encoder");
  let (width, height) = chain.output_size();
  let mut recorder = Mp4Recorder::create(Path::new(&options.output), VideoSettings {
    width, height, fps: fps.round().max(1.0) as u32, bitrate: options.bitrate,
  }, mixer.as_ref().map(|_| AudioSettings { channels: 2 }))?;

  // All work after creation is enclosed so finish also runs when it fails.
  let work = (|| -> Result<(), String> {
    if options.start_ms > 0.0 {
      set_stage(shared, "seek");
      source.seek_to_keyframe_before(options.start_ms)?;
      if let Some(camera) = webcam.as_mut() { camera.seek_to_keyframe_before(options.start_ms)?; }
    }
    let mut overlays = OverlayState::default();
    let mut latest_webcam_ms = f64::NEG_INFINITY;
    let mut rgba = Vec::new();
    let mut pending = Vec::new();
    let mut packets_written = 0u64;
    let mut audio_frames_written = 0u64;
    let mut last_composition_ms = origin_ms;
    // Video is timed from its own first frame, as the Windows encoder's frame
    // counter is. Timing it from `origin_ms` would put the first frame a few
    // milliseconds in whenever a trim starts between frames, and the recorder,
    // which rebases to its first video frame, would then drop the first audio
    // packet as early.
    let mut first_composition_ms = None;
    loop {
      if shared.cancel.load(Ordering::Acquire) { break; }
      set_stage(shared, "read_sample");
      let t_decode = Instant::now();
      let Some(frame) = source.next_frame()? else { break };
      let decode_us = t_decode.elapsed().as_micros() as u64;
      if frame.pts_ms + 0.5 < options.start_ms { continue; }
      if frame.pts_ms > end_ms { break; }
      if cuts.contains(frame.pts_ms) { continue; }
      let composition_ms = cuts.to_composition(frame.pts_ms);
      last_composition_ms = composition_ms;
      set_stage(shared, "render");
      let t_render = Instant::now();
      pull_webcam(&mut webcam, &mut overlays, &mut latest_webcam_ms, frame.pts_ms);
      overlays.stage_webcam(&mut chain, 0);
      chain.stage_timeline(0, composition_ms);
      frame.stage(&mut chain, 0)?;
      chain.render_slot(0)?;
      chain.read_rgba(&mut rgba)?;
      let render_us = t_render.elapsed().as_micros() as u64;
      set_stage(shared, "encode write_frame");
      let t_encode = Instant::now();
      let first = *first_composition_ms.get_or_insert(composition_ms);
      let pts = ((composition_ms - first).max(0.0) * 10_000.0).round() as i64;
      recorder.push_frame(&rgba, width, height, width as usize * 4, PixelOrder::Rgbx, pts)?;
      let encode_us = t_encode.elapsed().as_micros() as u64;
      if let (Some(mixer), Some(opus)) = (mixer.as_mut(), opus.as_ref()) {
        set_stage(shared, "write audio");
        let due = audio_frames_due(composition_ms - origin_ms, audio_frames_written);
        pending.extend(mixer.next_window(due));
        audio_frames_written += due as u64;
        write_packets(&mut recorder, opus, &mut pending, &mut packets_written)?;
      }
      shared.decode_us.fetch_add(decode_us, Ordering::Relaxed);
      shared.render_us.fetch_add(render_us, Ordering::Relaxed);
      shared.encode_us.fetch_add(encode_us, Ordering::Relaxed);
      if shared.frames_done.fetch_add(1, Ordering::Relaxed) == 0 {
        shared.setup_us.store(shared.started_at.elapsed().as_micros() as u64, Ordering::Relaxed);
      }
    }
    if shared.frames_done.load(Ordering::Relaxed) > 0 {
      if let (Some(mixer), Some(opus)) = (mixer.as_mut(), opus.as_ref()) {
        set_stage(shared, "flush audio");
        let due = audio_frames_due(last_composition_ms + 1000.0 / fps - origin_ms, audio_frames_written);
        pending.extend(mixer.next_window(due));
        write_packets(&mut recorder, opus, &mut pending, &mut packets_written)?;
        if !pending.is_empty() {
          pending.resize(PACKET_FRAMES * MIX_CHANNELS as usize, 0.0);
          write_packets(&mut recorder, opus, &mut pending, &mut packets_written)?;
        }
      }
    }
    Ok(())
  })();
  if work.is_ok() { set_stage(shared, "finalize"); }
  let finished = recorder.finish();
  if let Err(error) = work { return Err(error); }
  finished?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use super::super::audio::fixtures::{path, recording, Fixture, COLOURS};
  use super::super::player::PlaneSource;
  use crate::engine::mix::ChunkSource;
  use crate::engine::scene::DEFAULT_LAYER_ORDER;
  use std::time::Duration;

  fn options(input: &str, output: &str) -> Options {
    Options {
      input: input.into(), output: output.into(), bitrate: 2_000_000,
      start_ms: 0.0, end_ms: 0.0,
      effects: EffectParams { brightness: 0.0, contrast: 1.0, saturation: 1.0 },
      webcam_effects: EffectParams { brightness: 0.0, contrast: 1.0, saturation: 1.0 },
      canvas: None, layout: None, background: None, webcam_path: None,
      webcam_layout: None, cursor_image: None, cursor_images: Vec::new(),
      cursor_track: Vec::new(), cursor_size: 22.0, cursor_opacity: 1.0,
      cursor_effects: CursorEffects::default(), webcam_cuts: Vec::new(),
      layer_order: DEFAULT_LAYER_ORDER, webcam_zoom_regions: Vec::new(),
      zoom_regions: Vec::new(), audio_sources: vec![(input.into(), 0.0)],
      cuts: Vec::new(), crop: None,
    }
  }

  fn finished(exporter: &Exporter) -> Progress {
    for _ in 0..1000 {
      let progress = exporter.progress();
      if progress.finished { return progress; }
      std::thread::sleep(Duration::from_millis(20));
    }
    panic!("export did not finish within 20 seconds");
  }

  fn assert_output(path: &str, frames: u32, seconds: f64, colours: &[[u8; 4]]) {
    let file = std::fs::File::open(path).unwrap();
    let reader = mp4::read_mp4(file).unwrap();
    let video = reader.tracks().values().find(|track|
      track.track_type().ok() == Some(mp4::TrackType::Video)).unwrap();
    let audio = reader.tracks().values().find(|track|
      track.track_type().ok() == Some(mp4::TrackType::Audio)).unwrap();
    assert!((video.sample_count() as i64 - frames as i64).abs() <= 1);
    assert!((video.duration().as_secs_f64() - seconds).abs() < 0.05);
    assert!((audio.duration().as_secs_f64() - seconds).abs() < 0.05);
    let mut source = PlaneSource::open(path).unwrap();
    for (second, colour) in colours.iter().enumerate() {
      source.seek_to_keyframe_before(second as f64 * 1000.0 + 500.0).unwrap();
      let frame = loop {
        let frame = source.next_frame().unwrap().unwrap();
        if frame.pts_ms >= second as f64 * 1000.0 + 450.0 { break frame; }
      };
      // I420 centre pixel, with codec tolerance and the RGB→YUV transfer.
      let y = frame.y[24 * frame.strides.0 + 32] as i32;
      let expected = (0.257 * colour[0] as f64 + 0.504 * colour[1] as f64
        + 0.098 * colour[2] as f64 + 16.0).round() as i32;
      assert!((y - expected).abs() < 25, "second {second}: {y} versus {expected}");
    }
    let mut audio_source = OpusSource::open(path).unwrap().unwrap();
    let first = audio_source.read_chunk().unwrap();
    assert!(!first.end_of_stream);
  }

  #[test]
  fn whole_cut_and_trimmed_exports() {
    match RenderChain::new((64, 48), (64, 48), (64, 48), 1) {
      Ok(_) => {},
      Err(error) if error.contains("GPU adapter") => {
        println!("no adapter, skipping: {error}");
        return;
      }
      Err(error) => panic!("render chain: {error}"),
    }
    let fixture = recording(true);
    let input = fixture.0.to_str().unwrap();
    let whole = Fixture(path("export-whole"));
    let export = Exporter::start(options(input, whole.0.to_str().unwrap()));
    let progress = finished(&export);
    assert!(progress.error.is_none(), "{:?}", progress.error);
    assert!((progress.frames_done as i64 - 90).abs() <= 1);
    assert_output(whole.0.to_str().unwrap(), 90, 3.0, &COLOURS);

    let cut = Fixture(path("export-cut"));
    let mut cut_options = options(input, cut.0.to_str().unwrap());
    cut_options.cuts.push(Cut { start_ms: 1000.0, end_ms: 2000.0 });
    let export = Exporter::start(cut_options);
    let progress = finished(&export);
    assert!(progress.error.is_none(), "{:?}", progress.error);
    assert!((progress.frames_done as i64 - 60).abs() <= 1);
    assert_output(cut.0.to_str().unwrap(), 60, 2.0, &[COLOURS[0], COLOURS[2]]);

    let trimmed = Fixture(path("export-trimmed"));
    let mut trim_options = options(input, trimmed.0.to_str().unwrap());
    trim_options.start_ms = 1000.0;
    trim_options.end_ms = 2000.0;
    let export = Exporter::start(trim_options);
    let progress = finished(&export);
    assert!(progress.error.is_none(), "{:?}", progress.error);
    assert!((progress.frames_done as i64 - 30).abs() <= 1);
    assert_output(trimmed.0.to_str().unwrap(), 30, 1.0, &[COLOURS[1]]);

    // A trim that starts between frames. The audio is mixed from the trim
    // point and the video starts at the next frame; every audio packet must
    // still land, rather than the first being dropped as earlier than video.
    let between = Fixture(path("export-between"));
    let mut between_options = options(input, between.0.to_str().unwrap());
    between_options.start_ms = 1010.0;
    between_options.end_ms = 2010.0;
    let export = Exporter::start(between_options);
    let progress = finished(&export);
    assert!(progress.error.is_none(), "{:?}", progress.error);
    let reader = mp4::read_mp4(std::fs::File::open(&between.0).unwrap()).unwrap();
    let audio = reader.tracks().values().find(|track|
      track.track_type().ok() == Some(mp4::TrackType::Audio)).unwrap();
    // Frames 31..=60 are 1033..2000 ms; the mix runs from 1010 to one frame
    // past the last, 1023 ms, which is 52 packets of 20 ms.
    assert_eq!(audio.sample_count(), 52);
  }

  #[test]
  fn cancellation_finalises_and_missing_input_reports_stage() {
    let fixture = recording(true);
    let cancelled = Fixture(path("export-cancelled"));
    let export = Exporter::start(options(fixture.0.to_str().unwrap(), cancelled.0.to_str().unwrap()));
    // Allow one frame so the partial movie has a decodable video track.
    for _ in 0..1000 {
      if export.progress().frames_done > 0 { break; }
      std::thread::sleep(Duration::from_millis(5));
    }
    export.cancel();
    let progress = finished(&export);
    assert!(progress.cancelled && progress.finished);
    assert!(progress.error.is_none(), "{:?}", progress.error);
    let file = std::fs::File::open(&cancelled.0).unwrap();
    assert!(mp4::read_mp4(file).is_ok());
    let missing = Fixture(path("does-not-exist"));
    let output = Fixture(path("missing-output"));
    let export = Exporter::start(options(missing.0.to_str().unwrap(), output.0.to_str().unwrap()));
    let progress = finished(&export);
    assert!(progress.error.unwrap().starts_with("[open input]"));
  }
}
