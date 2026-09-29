//! MP4 samples become owned RGBA frames for the software engine.
//!
//! The recorder stores length-prefixed H.264 in MP4. OpenH264 expects start
//! codes, and a fresh decoder needs SPS/PPS at each sync sample so seeking can
//! begin there without decoding the preceding GOP.

use std::fs::File;
use std::io::BufReader;
use openh264::decoder::Decoder;
use openh264::formats::YUVSource;

/// Container timing and display geometry, independent of decoder state.
#[derive(Clone, Copy)]
pub(super) struct SourceInfo {
  pub width: u32,
  pub height: u32,
  pub coded_width: u32,
  pub coded_height: u32,
  pub duration_ms: f64,
  pub fps: f64,
  pub sample_count: u32,
}

/// One decoded picture, owned across decode calls.
pub(super) struct Frame {
  pub pts_ms: f64,
  pub width: u32,
  pub height: u32,
  pub rgba: Vec<u8>,
}

/// A sequential H.264 source with a sample cursor and resettable decoder.
pub(super) struct VideoSource {
  reader: mp4::Mp4Reader<BufReader<File>>,
  decoder: Decoder,
  track_id: u32,
  timescale: u32,
  sps: Vec<u8>,
  pps: Vec<u8>,
  info: SourceInfo,
  next_sample: u32,
}

impl VideoSource {
  /// Open the first H.264 track and retain its parameter sets for keyframes.
  pub fn open(path: &str) -> Result<Self, String> {
    let file = File::open(path).map_err(|error| format!("failed to open {path}: {error}"))?;
    let reader = mp4::read_mp4(file).map_err(|error| format!("failed to read {path} as MP4: {error}"))?;
    let track = reader.tracks().values()
      .filter(|track| track.media_type().ok() == Some(mp4::MediaType::H264))
      .min_by_key(|track| track.track_id())
      .ok_or_else(|| format!("no H.264 video track in {path}"))?;
    let sps = track.sequence_parameter_set()
      .map_err(|error| format!("missing H.264 SPS in {path}: {error}"))?.to_vec();
    let pps = track.picture_parameter_set()
      .map_err(|error| format!("missing H.264 PPS in {path}: {error}"))?.to_vec();
    let duration_ms = track.duration().as_secs_f64() * 1000.0;
    let sample_count = track.sample_count();
    let width = track.width() as u32;
    let height = track.height() as u32;
    let info = SourceInfo {
      width, height,
      coded_width: width.saturating_add(15) / 16 * 16,
      coded_height: height.saturating_add(15) / 16 * 16,
      duration_ms,
      fps: if duration_ms > 0.0 { sample_count as f64 * 1000.0 / duration_ms } else { 0.0 },
      sample_count,
    };
    let track_id = track.track_id();
    let timescale = track.timescale();
    if timescale == 0 { return Err(format!("video track in {path} has zero timescale")); }
    let decoder = Decoder::new().map_err(|error| format!("failed to initialize H.264 decoder: {error}"))?;
    Ok(Self { reader, decoder, track_id, timescale, sps, pps, info, next_sample: 1 })
  }

  /// Report display size and the best known decoded allocation size.
  pub fn info(&self) -> SourceInfo { self.info }

  /// Decode through samples until a picture is produced or the track ends.
  pub fn next_frame(&mut self) -> Result<Option<Frame>, String> {
    while self.next_sample <= self.info.sample_count {
      let sample_id = self.next_sample;
      self.next_sample += 1;
      let sample = self.reader.read_sample(self.track_id, sample_id)
        .map_err(|error| format!("failed to read video sample {sample_id}: {error}"))?
        .ok_or_else(|| format!("video sample {sample_id} is missing"))?;
      let mut annexb = Vec::with_capacity(sample.bytes.len() + self.sps.len() + self.pps.len() + 12);
      if sample.is_sync {
        append_nal(&mut annexb, &self.sps);
        append_nal(&mut annexb, &self.pps);
      }
      let mut remaining = sample.bytes.as_ref();
      while !remaining.is_empty() {
        if remaining.len() < 4 { return Err(format!("video sample {sample_id} has an incomplete NAL length")); }
        let length = u32::from_be_bytes([remaining[0], remaining[1], remaining[2], remaining[3]]) as usize;
        remaining = &remaining[4..];
        if length == 0 || length > remaining.len() {
          return Err(format!("video sample {sample_id} has an invalid NAL length"));
        }
        append_nal(&mut annexb, &remaining[..length]);
        remaining = &remaining[length..];
      }
      let decoded = self.decoder.decode(&annexb)
        .map_err(|error| format!("failed to decode video sample {sample_id}: {error}"))?;
      let Some(decoded) = decoded else { continue };
      let (width, height) = decoded.dimensions();
      let length = width.checked_mul(height).and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "decoded video dimensions are too large".to_string())?;
      let mut rgba = vec![0; length];
      decoded.write_rgba8(&mut rgba);
      self.info.coded_width = width as u32;
      self.info.coded_height = height as u32;
      let pts = sample.start_time as i128 + sample.rendering_offset as i128;
      let pts_ms = pts.max(0) as f64 * 1000.0 / self.timescale as f64;
      return Ok(Some(Frame { pts_ms, width: width as u32, height: height as u32, rgba }));
    }
    Ok(None)
  }

  /// Restart at the last sync sample whose presentation time does not exceed `ms`.
  pub fn seek_to_keyframe_before(&mut self, ms: f64) -> Result<(), String> {
    let target = if ms.is_finite() { ms.max(0.0) } else { 0.0 };
    let mut chosen = 1;
    for sample_id in 1..=self.info.sample_count {
      let sample = self.reader.read_sample(self.track_id, sample_id)
        .map_err(|error| format!("failed to inspect video sample {sample_id}: {error}"))?
        .ok_or_else(|| format!("video sample {sample_id} is missing"))?;
      let pts = sample.start_time as i128 + sample.rendering_offset as i128;
      let pts_ms = pts.max(0) as f64 * 1000.0 / self.timescale as f64;
      if sample.is_sync && pts_ms <= target { chosen = sample_id; }
    }
    self.decoder = Decoder::new().map_err(|error| format!("failed to reset H.264 decoder: {error}"))?;
    self.next_sample = chosen;
    Ok(())
  }
}

fn append_nal(target: &mut Vec<u8>, nal: &[u8]) {
  target.extend_from_slice(&[0, 0, 0, 1]);
  target.extend_from_slice(nal);
}

#[cfg(test)]
pub(super) mod fixtures {
  use openh264::encoder::{BitRate, Encoder, EncoderConfig, FrameRate, FrameType,
    IntraFramePeriod, RateControlMode, UsageType};
  use openh264::formats::{BgraSliceU8, YUVBuffer};
  use openh264::{OpenH264API, Timestamp};
  use std::path::PathBuf;
  use std::sync::atomic::{AtomicUsize, Ordering};

  static NEXT_FILE: AtomicUsize = AtomicUsize::new(0);
  pub struct Fixture(pub PathBuf);
  impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }

  pub fn path(name: &str, extension: &str) -> PathBuf {
    std::env::temp_dir().join(format!("velocity-linux-{name}-{}-{}.{}",
      std::process::id(), NEXT_FILE.fetch_add(1, Ordering::Relaxed), extension))
  }

  // capture::linux is private to capture.rs. Build the same H.264/MP4 layout
  // here to exercise the engine without widening that unrelated module's API.
  pub fn recording(audio: bool) -> Fixture { recording_sized(audio, 64, 48) }

  /// A recording at any even size, for pictures that aren't macroblock-aligned.
  pub fn recording_sized(audio: bool, width: usize, height: usize) -> Fixture {
    recording_painted(audio, width, height, [[20, 40, 210, 0], [30, 200, 50, 0], [210, 45, 30, 0]])
  }

  /// A recording whose three seconds are painted with `palette` (BGRX), one
  /// colour per second.
  pub fn recording_painted(audio: bool, width: usize, height: usize,
    palette: [[u8; 4]; 3]) -> Fixture {
    let path = path("recording", "mp4");
    let config = EncoderConfig::new()
      .bitrate(BitRate::from_bps(2_000_000))
      .max_frame_rate(FrameRate::from_hz(30.0))
      .usage_type(UsageType::ScreenContentRealTime)
      .rate_control_mode(RateControlMode::Bitrate)
      .adaptive_quantization(false)
      .background_detection(false)
      .skip_frames(false)
      .intra_frame_period(IntraFramePeriod::from_num_frames(60));
    let mut encoder = Encoder::with_api_config(OpenH264API::from_source(), config).unwrap();
    let mut yuv = YUVBuffer::new(width, height);
    let mut samples = Vec::new();
    let mut sps = Vec::new();
    let mut pps = Vec::new();
    for index in 0..90 {
      let colour = palette[(index / 30).min(2)];
      let pixels = colour.repeat(width * height);
      yuv.read_bgra8(BgraSliceU8::new(&pixels, (width, height)));
      let encoded = encoder.encode_at(&yuv, Timestamp::from_millis(index as u64 * 33)).unwrap();
      let mut avcc = Vec::new();
      for layer_index in 0..encoded.num_layers() {
        let layer = encoded.layer(layer_index).unwrap();
        for nal_index in 0..layer.nal_count() {
          let nal = layer.nal_unit(nal_index).unwrap();
          let header = if nal.starts_with(&[0, 0, 0, 1]) { 4 } else { 3 };
          let nal = &nal[header..];
          match nal[0] & 0x1f {
            7 => sps = nal.to_vec(),
            8 => pps = nal.to_vec(),
            _ => {}
          }
          avcc.extend_from_slice(&(nal.len() as u32).to_be_bytes());
          avcc.extend_from_slice(nal);
        }
      }
      samples.push((avcc, encoded.frame_type() == FrameType::IDR));
    }
    let config = mp4::Mp4Config {
      major_brand: "isom".parse().unwrap(), minor_version: 512,
      compatible_brands: vec!["isom".parse().unwrap(), "avc1".parse().unwrap()],
      timescale: 1000,
    };
    let file = std::fs::File::create(&path).unwrap();
    let mut writer = mp4::Mp4Writer::write_start(file, &config).unwrap();
    writer.add_track(&mp4::TrackConfig {
      track_type: mp4::TrackType::Video, timescale: 30_000,
      language: "und".into(), media_conf: mp4::MediaConfig::AvcConfig(mp4::AvcConfig {
        width: width as u16, height: height as u16, seq_param_set: sps, pic_param_set: pps,
      }),
    }).unwrap();
    if audio {
      writer.add_track(&mp4::TrackConfig {
        track_type: mp4::TrackType::Audio, timescale: 48_000,
        language: "und".into(), media_conf: mp4::MediaConfig::AacConfig(mp4::AacConfig::default()),
      }).unwrap();
    }
    for (index, (bytes, is_sync)) in samples.into_iter().enumerate() {
      writer.write_sample(1, &mp4::Mp4Sample {
        start_time: index as u64 * 1000, duration: 1000,
        rendering_offset: 0, is_sync, bytes: bytes.into(),
      }).unwrap();
      if audio {
        writer.write_sample(2, &mp4::Mp4Sample {
          start_time: index as u64 * 1600, duration: 1600,
          rendering_offset: 0, is_sync: true,
          bytes: vec![0xF8, 0xFF, 0xFE].into(),
        }).unwrap();
      }
    }
    writer.write_end().unwrap();
    if audio {
      // The typed writer emits mp4a; convert its sample-entry fourcc to the
      // recorder's Opus entry while preserving the common channel-count field.
      let mut bytes = std::fs::read(&path).unwrap();
      let offset = bytes.windows(4).position(|window| window == b"mp4a").unwrap();
      bytes[offset..offset + 4].copy_from_slice(b"Opus");
      std::fs::write(&path, bytes).unwrap();
    }
    Fixture(path)
  }
}

#[cfg(test)]
mod decode_scenarios {
  use super::*;
  use super::fixtures::recording;
  #[test]
  fn ninety_frames_decode_with_increasing_pts_and_expected_geometry() {
    let fixture = recording(false);
    let mut source = VideoSource::open(fixture.0.to_str().unwrap()).unwrap();
    let info = source.info();
    assert_eq!((info.width, info.height, info.sample_count), (64, 48, 90));
    assert!((info.duration_ms - 3000.0).abs() < 100.0);
    assert!((info.fps - 30.0).abs() < 1.0);
    let mut previous = -1.0;
    let mut count = 0;
    while let Some(frame) = source.next_frame().unwrap() {
      assert!(frame.pts_ms > previous);
      previous = frame.pts_ms;
      count += 1;
    }
    assert_eq!(count, 90);
    assert!(source.next_frame().unwrap().is_none());
  }
  #[test]
  fn centre_pixel_keeps_the_encoded_colour_with_codec_tolerance() {
    let fixture = recording(false);
    let mut source = VideoSource::open(fixture.0.to_str().unwrap()).unwrap();
    let frame = source.next_frame().unwrap().unwrap();
    let offset = ((24 * frame.width + 32) * 4) as usize;
    for (actual, expected) in frame.rgba[offset..offset + 3].iter().zip([210, 40, 20]) {
      assert!((*actual as i16 - expected).abs() <= 20);
    }
  }
  #[test]
  fn seek_lands_on_a_sync_picture_before_the_requested_time() {
    let fixture = recording(false);
    let mut source = VideoSource::open(fixture.0.to_str().unwrap()).unwrap();
    source.seek_to_keyframe_before(2500.0).unwrap();
    let sample = source.reader.read_sample(source.track_id, source.next_sample).unwrap().unwrap();
    assert!(sample.is_sync);
    let frame = source.next_frame().unwrap().unwrap();
    assert!(frame.pts_ms <= 2500.0);
    assert!(frame.pts_ms >= 1900.0);
  }
}
