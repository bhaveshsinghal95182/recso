//! The Linux napi surface mirrors the shared Windows declarations.
//!
//! Decode stays in software here. Texture fields remain optional until the
//! separate GPU player is available, so Electron can identify that boundary.

use super::{media::VideoSource, thumbnails};
use crate::engine::sheet::{SheetBudget, SheetPlan};
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn engine_version() -> String {
  format!("{} velocity-linux-software", env!("CARGO_PKG_VERSION"))
}

/// Shape retained for callers that also run on Windows; Linux returns no texture.
#[napi(object)]
pub struct SharedTextureInfo {
  pub handle: f64,
  pub width: u32,
  pub height: u32,
  pub visible_width: u32,
  pub visible_height: u32,
  pub pixel_format: String,
  pub timestamp: f64,
}

#[napi(object)]
pub struct VideoInfo {
  pub width: u32,
  pub height: u32,
  pub coded_width: u32,
  pub coded_height: u32,
  pub duration: f64,
  pub fps: f64,
}

#[napi(object)]
pub struct FrameResult {
  pub end_of_stream: bool,
  pub timestamp: f64,
  pub frames_decoded: f64,
  pub decode_ms: f64,
  pub texture: Option<SharedTextureInfo>,
}

/// Owns a sequential software decoder for one local recording.
#[napi]
pub struct VideoDecoder {
  inner: VideoSource,
  frames_decoded: u64,
  last_timestamp: f64,
}

#[napi]
impl VideoDecoder {
  #[napi(constructor)]
  pub fn new(path: String) -> Result<Self> {
    Ok(Self { inner: VideoSource::open(&path).map_err(Error::from_reason)?,
      frames_decoded: 0, last_timestamp: 0.0 })
  }

  #[napi]
  pub fn info(&self) -> VideoInfo {
    let info = self.inner.info();
    VideoInfo { width: info.width, height: info.height,
      coded_width: info.coded_width, coded_height: info.coded_height,
      duration: info.duration_ms, fps: info.fps }
  }

  /// Decode the next picture and report its presentation time.
  #[napi]
  pub fn next_frame(&mut self) -> Result<FrameResult> {
    let started = std::time::Instant::now();
    let frame = self.inner.next_frame().map_err(Error::from_reason)?;
    let end_of_stream = frame.is_none();
    if let Some(frame) = frame {
      self.frames_decoded += 1;
      self.last_timestamp = frame.pts_ms;
    }
    Ok(FrameResult { end_of_stream, timestamp: self.last_timestamp,
      frames_decoded: self.frames_decoded as f64,
      decode_ms: started.elapsed().as_secs_f64() * 1000.0, texture: None })
  }

  /// Seek to a millisecond offset. Lands on the preceding keyframe.
  #[napi]
  pub fn seek(&mut self, ms: f64) -> Result<()> {
    self.inner.seek_to_keyframe_before(ms).map_err(Error::from_reason)
  }
}

#[napi(object)]
pub struct ProbeResult {
  pub opened: bool,
  pub error: String,
  pub native_types: Vec<String>,
}

#[napi(object)]
pub struct AudioProbe {
  pub has_audio: bool,
  pub sample_rate: u32,
  pub channels: u32,
  pub duration: f64,
}

#[napi]
pub fn probe_video(path: String) -> ProbeResult {
  let result = VideoSource::open(&path).and_then(|mut source| {
    source.next_frame()?.ok_or_else(|| format!("no decodable H.264 frame in {path}"))
  });
  match result {
    Ok(_) => ProbeResult { opened: true, error: String::new(), native_types: vec!["avc1".into()] },
    Err(error) => ProbeResult { opened: false, error, native_types: Vec::new() },
  }
}

/// Inspect the first audio track, including this recorder's raw Opus entry.
#[napi]
pub fn probe_audio(path: String) -> AudioProbe {
  let absent = || AudioProbe { has_audio: false, sample_rate: 0, channels: 0, duration: 0.0 };
  let Ok(file) = std::fs::File::open(&path) else { return absent() };
  let Ok(reader) = mp4::read_mp4(file) else { return absent() };
  let Some(track) = reader.tracks().values()
    .filter(|track| track.track_type().ok() == Some(mp4::TrackType::Audio))
    .min_by_key(|track| track.track_id()) else { return absent() };
  let Ok(bytes) = std::fs::read(&path) else { return absent() };
  let Some(channels) = audio_channels(&bytes, track.track_id()) else { return absent() };
  AudioProbe { has_audio: true, sample_rate: 48_000, channels: channels as u32,
    duration: track.duration().as_secs_f64() * 1000.0 }
}

// The recorder uses an extended-size mdat at top level. Stay within each
// parent's payload, so malformed lengths cannot run into another track's stsd.
fn boxes(mut bytes: &[u8]) -> impl Iterator<Item = (&[u8; 4], &[u8])> {
  std::iter::from_fn(move || {
    if bytes.len() < 8 { return None; }
    let short_size = u32::from_be_bytes(bytes[..4].try_into().ok()?);
    let (size, header) = if short_size == 1 {
      (usize::try_from(u64::from_be_bytes(bytes.get(8..16)?.try_into().ok()?)).ok()?, 16)
    } else if short_size == 0 { (bytes.len(), 8) }
    else { (short_size as usize, 8) };
    if size < header || size > bytes.len() { return None; }
    let (item, rest) = bytes.split_at(size);
    bytes = rest;
    Some((item[4..8].try_into().ok()?, &item[header..]))
  })
}

fn child<'a>(bytes: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
  boxes(bytes).find(|(name, _)| *name == kind).map(|(_, data)| data)
}

fn audio_channels(bytes: &[u8], track_id: u32) -> Option<u16> {
  let moov = child(bytes, b"moov")?;
  for (kind, trak) in boxes(moov) {
    if kind != b"trak" { continue; }
    let tkhd = child(trak, b"tkhd")?;
    let id_offset = if *tkhd.first()? == 1 { 20 } else { 12 };
    let id = u32::from_be_bytes(tkhd.get(id_offset..id_offset + 4)?.try_into().ok()?);
    if id != track_id { continue; }
    let stsd = child(child(child(child(trak, b"mdia")?, b"minf")?, b"stbl")?, b"stsd")?;
    // Version/flags and entry_count precede the sample entries.
    let entries = stsd.get(8..)?;
    for (format, entry) in boxes(entries) {
      if format == b"Opus" || format == b"mp4a" {
        // Six reserved bytes + two-byte data reference + eight reserved bytes.
        return Some(u16::from_be_bytes(entry.get(16..18)?.try_into().ok()?));
      }
    }
    return None;
  }
  None
}

#[napi]
pub fn list_decoders() -> Vec<String> { vec!["openh264 (software)".into()] }
#[napi]
pub fn adapter_info() -> Vec<String> { Vec::new() }
#[napi]
pub fn gpu_decoder_profiles() -> Vec<String> { Vec::new() }

#[napi(object)]
pub struct GpuMemory { pub used: f64, pub budget: f64 }
#[napi]
pub fn gpu_memory() -> GpuMemory { GpuMemory { used: 0.0, budget: 0.0 } }

#[napi(object)]
pub struct SpritesheetOptions {
  pub max_frames: Option<u32>,
  pub cell_width: Option<u32>,
  pub max_columns: Option<u32>,
}

#[napi(object)]
pub struct SpritesheetInfo {
  pub frame_count: u32,
  pub interval_ms: f64,
  pub frame_width: u32,
  pub frame_height: u32,
  pub columns: u32,
  pub rows: u32,
  pub total_duration_ms: f64,
  pub image_path: String,
}

fn sheet_budget(options: Option<SpritesheetOptions>) -> SheetBudget {
  let defaults = SheetBudget::default();
  let Some(options) = options else { return defaults };
  SheetBudget {
    max_frames: options.max_frames.map(|value| value.max(1) as usize).unwrap_or(defaults.max_frames),
    cell_width: options.cell_width.map(|value| value.max(1)).unwrap_or(defaults.cell_width),
    max_columns: options.max_columns.map(|value| value.max(1)).unwrap_or(defaults.max_columns),
  }
}

pub struct BuildSpritesheet { input: String, output: String, budget: SheetBudget }
impl Task for BuildSpritesheet {
  type Output = (SheetPlan, f64);
  type JsValue = SpritesheetInfo;
  fn compute(&mut self) -> Result<Self::Output> {
    thumbnails::generate(&self.input, &self.output, self.budget).map_err(Error::from_reason)
  }
  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    let (plan, duration_ms) = output;
    Ok(SpritesheetInfo { frame_count: plan.frame_count as u32,
      interval_ms: plan.interval_ms, frame_width: plan.cell_width,
      frame_height: plan.cell_height, columns: plan.columns, rows: plan.rows,
      total_duration_ms: duration_ms, image_path: std::mem::take(&mut self.output) })
  }
}

/// Build the timeline filmstrip on a worker and return its PNG geometry.
#[napi(ts_return_type = "Promise<SpritesheetInfo>")]
pub fn generate_spritesheet(input: String, output: String,
  options: Option<SpritesheetOptions>) -> AsyncTask<BuildSpritesheet> {
  AsyncTask::new(BuildSpritesheet { input, output, budget: sheet_budget(options) })
}

#[cfg(test)]
mod api_scenarios {
  use super::*;
  use crate::engine::linux::media::fixtures::{path, recording};
  #[test]
  fn decoder_reports_eos_after_ninety_frames() {
    let fixture = recording(false);
    let mut decoder = VideoDecoder::new(fixture.0.to_str().unwrap().into()).unwrap();
    for count in 1..=90 {
      let result = decoder.next_frame().unwrap();
      assert!(!result.end_of_stream);
      assert_eq!(result.frames_decoded, count as f64);
      assert!(result.texture.is_none());
    }
    assert!(decoder.next_frame().unwrap().end_of_stream);
  }
  #[test]
  fn video_probe_requires_a_decodable_h264_frame() {
    let fixture = recording(false);
    let probe = probe_video(fixture.0.to_str().unwrap().into());
    assert!(probe.opened);
    assert_eq!(probe.native_types, ["avc1"]);
    let text = path("invalid", "txt");
    std::fs::write(&text, b"plain text").unwrap();
    let probe = probe_video(text.to_str().unwrap().into());
    let _ = std::fs::remove_file(text);
    assert!(!probe.opened);
    assert!(!probe.error.is_empty());
  }
  #[test]
  fn audio_probe_reads_opus_channels_and_detects_silent_video() {
    let fixture = recording(true);
    let probe = probe_audio(fixture.0.to_str().unwrap().into());
    assert!(probe.has_audio);
    assert_eq!((probe.sample_rate, probe.channels), (48_000, 2));
    assert!(probe.duration > 0.0);
    let fixture = recording(false);
    assert!(!probe_audio(fixture.0.to_str().unwrap().into()).has_audio);
  }
  #[test]
  fn zero_sheet_options_are_clamped_before_planning() {
    let budget = sheet_budget(Some(SpritesheetOptions {
      max_frames: Some(0), cell_width: Some(0), max_columns: Some(0) }));
    assert_eq!((budget.max_frames, budget.cell_width, budget.max_columns), (1, 1, 1));
  }
}
