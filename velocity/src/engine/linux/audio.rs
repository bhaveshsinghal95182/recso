//! Streaming Opus-in-MP4 audio for the Linux export mixer.
//!
//! Only `moov` is buffered: the recorder's extended-size `mdat` may be huge.
//! Libopus decodes at 48 kHz; the shared mixer places the resulting chunks.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};

use crate::engine::mix::{AudioChunk, ChunkSource, MIX_SAMPLE_RATE};

/// Information needed to map Opus's decoded clock onto MP4 presentation time.
#[derive(Clone, Copy, Debug)]
pub(crate) struct OpusHeader {
  pub(crate) track_id: u32,
  pub(crate) channels: u8,
  pub(crate) pre_skip: u16,
  pub(crate) duration_ms: f64,
}

fn boxes(mut bytes: &[u8]) -> impl Iterator<Item = (&[u8; 4], &[u8])> {
  std::iter::from_fn(move || {
    if bytes.len() < 8 { return None; }
    let short = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?);
    let (size, header) = if short == 1 {
      (usize::try_from(u64::from_be_bytes(bytes.get(8..16)?.try_into().ok()?)).ok()?, 16)
    } else if short == 0 { (bytes.len(), 8) } else { (short as usize, 8) };
    if size < header || size > bytes.len() { return None; }
    let (item, rest) = bytes.split_at(size);
    bytes = rest;
    Some((item[4..8].try_into().ok()?, &item[header..]))
  })
}

fn child<'a>(bytes: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
  boxes(bytes).find(|(name, _)| *name == kind).map(|(_, data)| data)
}

fn parse_track(trak: &[u8]) -> Option<OpusHeader> {
  let tkhd = child(trak, b"tkhd")?;
  let id_offset = if *tkhd.first()? == 1 { 20 } else { 12 };
  let track_id = u32::from_be_bytes(tkhd.get(id_offset..id_offset + 4)?.try_into().ok()?);
  let mdia = child(trak, b"mdia")?;
  let hdlr = child(mdia, b"hdlr")?;
  if hdlr.get(8..12)? != b"soun" { return None; }
  let mdhd = child(mdia, b"mdhd")?;
  let (scale_at, duration_at, duration_len) = if *mdhd.first()? == 1 { (20, 24, 8) } else { (12, 16, 4) };
  let scale = u32::from_be_bytes(mdhd.get(scale_at..scale_at + 4)?.try_into().ok()?);
  if scale == 0 { return None; }
  let duration = if duration_len == 8 {
    u64::from_be_bytes(mdhd.get(duration_at..duration_at + 8)?.try_into().ok()?)
  } else {
    u32::from_be_bytes(mdhd.get(duration_at..duration_at + 4)?.try_into().ok()?) as u64
  };
  let stsd = child(child(child(mdia, b"minf")?, b"stbl")?, b"stsd")?;
  for (format, entry) in boxes(stsd.get(8..)?) {
    if format != b"Opus" { continue; }
    let dops = child(entry.get(28..)?, b"dOps");
    let channels = match dops {
      Some(data) => *data.get(1)?,
      None => u16::from_be_bytes(entry.get(16..18)?.try_into().ok()?) as u8,
    };
    let pre_skip = dops.and_then(|data| data.get(2..4))
      .and_then(|bytes| bytes.try_into().ok()).map(u16::from_be_bytes).unwrap_or(0);
    if channels != 1 && channels != 2 { return None; }
    return Some(OpusHeader { track_id, channels, pre_skip,
      duration_ms: duration as f64 * 1000.0 / scale as f64 });
  }
  None
}

/// Walk top-level box headers with seeks and read just the movie metadata.
pub(crate) fn read_opus_header(path: &str) -> Result<Option<OpusHeader>, String> {
  let mut file = File::open(path).map_err(|e| format!("open {path}: {e}"))?;
  let len = file.metadata().map_err(|e| e.to_string())?.len();
  let mut offset = 0u64;
  while offset < len {
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut header = [0u8; 16];
    file.read_exact(&mut header[..8]).map_err(|e| e.to_string())?;
    let short = u32::from_be_bytes(header[..4].try_into().map_err(|_| "invalid box size")?);
    let (size, head) = if short == 1 {
      file.read_exact(&mut header[8..]).map_err(|e| e.to_string())?;
      (u64::from_be_bytes(header[8..].try_into().map_err(|_| "invalid extended size")?), 16)
    } else if short == 0 { (len - offset, 8) } else { (short as u64, 8) };
    if size < head || size > len - offset { return Err("invalid top-level MP4 box size".into()); }
    if &header[4..8] == b"moov" {
      let payload_len = usize::try_from(size - head).map_err(|_| "moov is too large")?;
      let mut moov = vec![0; payload_len];
      file.read_exact(&mut moov).map_err(|e| e.to_string())?;
      return Ok(boxes(&moov).filter(|(kind, _)| *kind == b"trak")
        .filter_map(|(_, trak)| parse_track(trak)).min_by_key(|track| track.track_id));
    }
    offset += size;
  }
  Ok(None)
}

struct Decoder(*mut opusic_sys::OpusDecoder);
// SAFETY: Each decoder belongs to one source on the export thread.
unsafe impl Send for Decoder {}
impl Decoder {
  fn new(channels: u8) -> Result<Self, String> {
    let mut code = 0;
    // SAFETY: The error pointer is writable and libopus accepts 48 kHz mono/stereo.
    let ptr = unsafe { opusic_sys::opus_decoder_create(MIX_SAMPLE_RATE as i32, channels as i32, &mut code) };
    if code != opusic_sys::OPUS_OK || ptr.is_null() { return Err(format!("create Opus decoder: {code}")); }
    Ok(Self(ptr))
  }
}
impl Drop for Decoder {
  fn drop(&mut self) {
    // SAFETY: The pointer was created by libopus and is destroyed once here.
    unsafe { opusic_sys::opus_decoder_destroy(self.0) };
  }
}

/// Sequential packet decoder with exact pre-skip and seek trimming.
pub(crate) struct OpusSource {
  reader: mp4::Mp4Reader<BufReader<File>>,
  decoder: Decoder,
  header: OpusHeader,
  sample_count: u32,
  next_sample: u32,
  discard_before: i64,
}
impl OpusSource {
  pub(crate) fn open(path: &str) -> Result<Option<Self>, String> {
    let Some(header) = read_opus_header(path)? else { return Ok(None) };
    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader = mp4::read_mp4(file).map_err(|e| e.to_string())?;
    let sample_count = reader.tracks().get(&header.track_id)
      .ok_or("Opus track missing from sample tables")?.sample_count();
    Ok(Some(Self { reader, decoder: Decoder::new(header.channels)?, header,
      sample_count, next_sample: 1, discard_before: 0 }))
  }
}
impl ChunkSource for OpusSource {
  type Error = String;
  fn channels(&self) -> u32 { self.header.channels as u32 }
  fn read_chunk(&mut self) -> Result<AudioChunk, String> {
    while self.next_sample <= self.sample_count {
      let id = self.next_sample;
      self.next_sample += 1;
      let sample = self.reader.read_sample(self.header.track_id, id)
        .map_err(|e| e.to_string())?.ok_or_else(|| format!("missing Opus sample {id}"))?;
      let mut samples = vec![0.0; 5760 * self.header.channels as usize];
      // SAFETY: The decoder is live; packet and output buffers remain valid for this call.
      let frames = unsafe { opusic_sys::opus_decode_float(self.decoder.0, sample.bytes.as_ptr(),
        sample.bytes.len() as i32, samples.as_mut_ptr(), 5760, 0) };
      if frames < 0 { return Err(format!("decode Opus sample {id}: {frames}")); }
      let start = sample.start_time as i64 - self.header.pre_skip as i64;
      let keep_from = start.max(0).max(self.discard_before);
      let skip = (keep_from - start).clamp(0, frames as i64) as usize;
      if skip == frames as usize { continue; }
      samples.truncate(frames as usize * self.header.channels as usize);
      samples.drain(..skip * self.header.channels as usize);
      return Ok(AudioChunk { timestamp_100ns: keep_from * 10_000_000 / MIX_SAMPLE_RATE as i64,
        samples, end_of_stream: false });
    }
    Ok(AudioChunk { timestamp_100ns: 0, samples: Vec::new(), end_of_stream: true })
  }
  fn seek(&mut self, position_100ns: i64) -> Result<(), String> {
    let target = (position_100ns.max(0) as i128 * MIX_SAMPLE_RATE as i128 / 10_000_000) as i64;
    let preroll = (target - 3840).max(0) + self.header.pre_skip as i64;
    self.next_sample = (preroll / 960 + 1).clamp(1, self.sample_count as i64 + 1) as u32;
    self.discard_before = target;
    self.decoder = Decoder::new(self.header.channels)?;
    Ok(())
  }
}

#[cfg(test)]
pub(crate) mod fixtures {
  use crate::capture::linux::audio::{OpusEncoder, PACKET_FRAMES};
  use crate::capture::linux::encoder::{AudioSettings, Mp4Recorder, PixelOrder, VideoSettings};
  use std::path::PathBuf;
  use std::sync::atomic::{AtomicUsize, Ordering};

  static NEXT: AtomicUsize = AtomicUsize::new(0);
  pub(crate) const COLOURS: [[u8; 4]; 3] = [[210, 40, 20, 0], [50, 200, 30, 0], [30, 45, 210, 0]];
  pub(crate) struct Fixture(pub(crate) PathBuf);
  impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
  }
  pub(crate) fn path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("velocity-{label}-{}-{}.mp4",
      std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)))
  }
  pub(crate) fn recording(with_audio: bool) -> Fixture {
    let path = path("opus-fixture");
    let mut recorder = Mp4Recorder::create(&path, VideoSettings {
      width: 64, height: 48, fps: 30, bitrate: 2_000_000,
    }, with_audio.then_some(AudioSettings { channels: 2 })).unwrap();
    let encoder = with_audio.then(|| OpusEncoder::new().unwrap());
    let mut packet_index = 0usize;
    for frame in 0..90 {
      let pixels = COLOURS[frame / 30].repeat(64 * 48);
      let video_pts = (frame as i64 * 10_000_000) / 30;
      recorder.push_frame(&pixels, 64, 48, 64 * 4, PixelOrder::Rgbx, video_pts).unwrap();
      if let Some(encoder) = encoder.as_ref() {
        while packet_index < 150 && packet_index as i64 * 200_000 <= video_pts {
          let mut pcm = [0f32; PACKET_FRAMES * 2];
          for i in 0..PACKET_FRAMES {
            let t = (packet_index * PACKET_FRAMES + i) as f32 / 48_000.0;
            let sample = (t * 440.0 * std::f32::consts::TAU).sin() * 0.5;
            pcm[i * 2] = sample;
            pcm[i * 2 + 1] = sample;
          }
          let packet = encoder.encode(&pcm).unwrap();
          recorder.push_audio_packet(&packet, packet_index as i64 * 200_000).unwrap();
          packet_index += 1;
        }
      }
    }
    if let Some(encoder) = encoder.as_ref() {
      while packet_index < 150 {
        let mut pcm = [0f32; PACKET_FRAMES * 2];
        for i in 0..PACKET_FRAMES {
          let t = (packet_index * PACKET_FRAMES + i) as f32 / 48_000.0;
          let sample = (t * 440.0 * std::f32::consts::TAU).sin() * 0.5;
          pcm[i * 2] = sample;
          pcm[i * 2 + 1] = sample;
        }
        let packet = encoder.encode(&pcm).unwrap();
        recorder.push_audio_packet(&packet, packet_index as i64 * 200_000).unwrap();
        packet_index += 1;
      }
    }
    recorder.finish().unwrap();
    Fixture(path)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use fixtures::{path, recording, Fixture};

  #[test]
  fn reads_only_moov_even_after_a_large_mdat() {
    let fixture = recording(true);
    let header = read_opus_header(fixture.0.to_str().unwrap()).unwrap().unwrap();
    assert_eq!((header.channels, header.pre_skip), (2, 312));
    let probe = super::super::api::probe_audio(fixture.0.to_str().unwrap().into());
    assert_eq!((probe.sample_rate, probe.channels), (48_000, 2));
    let bytes = std::fs::read(&fixture.0).unwrap();
    let moov_at = bytes.windows(4).position(|part| part == b"moov").unwrap() - 4;
    let large = Fixture(path("large-mdat"));
    let mut file = File::create(&large.0).unwrap();
    use std::io::Write;
    file.write_all(&1u32.to_be_bytes()).unwrap();
    file.write_all(b"mdat").unwrap();
    let mdat_size = 5_000_000_000u64;
    file.write_all(&mdat_size.to_be_bytes()).unwrap();
    file.seek(SeekFrom::Start(mdat_size)).unwrap();
    file.write_all(&bytes[moov_at..]).unwrap();
    assert_eq!(read_opus_header(large.0.to_str().unwrap()).unwrap().unwrap().pre_skip, 312);
    let silent = recording(false);
    assert!(read_opus_header(silent.0.to_str().unwrap()).unwrap().is_none());
  }

  #[test]
  fn decodes_and_seeks_sine() {
    let fixture = recording(true);
    let mut source = OpusSource::open(fixture.0.to_str().unwrap()).unwrap().unwrap();
    let mut frames = 0usize;
    let mut middle: Vec<f32> = Vec::new();
    let mut last = -1i64;
    loop {
      let chunk = source.read_chunk().unwrap();
      if chunk.end_of_stream { break; }
      assert!(chunk.timestamp_100ns > last);
      last = chunk.timestamp_100ns;
      if (10_000_000..20_000_000).contains(&last) { middle.extend(chunk.samples.iter().step_by(2)); }
      frames += chunk.samples.len() / 2;
    }
    assert!((frames as i64 - 144_000).abs() <= 960);
    let rms = (middle.iter().map(|v| v * v).sum::<f32>() / middle.len() as f32).sqrt();
    assert!((rms - 0.5 / 2f32.sqrt()).abs() < 0.5 / 2f32.sqrt() * 0.2);
    source.seek(15_000_000).unwrap();
    let chunk = source.read_chunk().unwrap();
    assert!((chunk.timestamp_100ns - 15_000_000).abs() <= 200_000);
    assert!(chunk.samples.iter().any(|sample| sample.abs() > 0.2));
  }
}
