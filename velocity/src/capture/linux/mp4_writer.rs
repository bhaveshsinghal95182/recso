//! Streams encoded samples to disk as they arrive. A screen recording can be
//! hours long, so retaining its compressed video until finalization would use
//! gigabytes of memory and exceed the classic 32-bit `mdat` limit.

use std::io::{Seek, SeekFrom, Write};

/// The dimensions stored in the H.264 sample entry.
pub(crate) struct VideoTrack {
  /// Encoded width in pixels, bounded by the 16-bit avc1 field.
  pub(crate) width: u32,
  /// Encoded height in pixels, bounded by the 16-bit avc1 field.
  pub(crate) height: u32,
}

/// An Opus track at 48 kHz; only its channel count is configurable.
pub(crate) struct AudioTrack {
  /// Output channels represented in the Opus decoder configuration.
  pub(crate) channels: u16,
}

struct Sample {
  size: u32,
  offset: u64,
  pts: i64,
  keyframe: bool,
}

/// Appends media immediately and keeps only the sample index until finish.
pub(crate) struct Mp4Writer<W: Write + Seek> {
  writer: W,
  mdat_start: u64,
  video: VideoTrack,
  audio: Option<AudioTrack>,
  videos: Vec<Sample>,
  audios: Vec<Sample>,
  sps: Option<Vec<u8>>,
  pps: Option<Vec<u8>>,
}

impl<W: Write + Seek> Mp4Writer<W> {
  /// Writes `ftyp` and a large-size `mdat` header before accepting samples.
  pub(crate) fn new(
    mut writer: W,
    video: VideoTrack,
    audio: Option<AudioTrack>,
  ) -> Result<Self, String> {
    if video.width == 0
      || video.height == 0
      || video.width > u16::MAX as u32
      || video.height > u16::MAX as u32
    {
      return Err("video dimensions must fit the MP4 sample entry".into());
    }
    if audio.as_ref().is_some_and(|track| track.channels == 0) {
      return Err("audio channel count must be greater than zero".into());
    }
    writer
      .write_all(&ftyp())
      .map_err(|e| format!("write MP4 ftyp: {e}"))?;
    let mdat_start = writer
      .stream_position()
      .map_err(|e| format!("locate MP4 mdat: {e}"))?;
    writer
      .write_all(&1_u32.to_be_bytes())
      .and_then(|_| writer.write_all(b"mdat"))
      .and_then(|_| writer.write_all(&0_u64.to_be_bytes()))
      .map_err(|e| format!("write MP4 mdat header: {e}"))?;
    Ok(Self {
      writer,
      mdat_start,
      video,
      audio,
      videos: Vec::new(),
      audios: Vec::new(),
      sps: None,
      pps: None,
    })
  }

  /// Accepts one Annex B access unit on a strictly increasing file-relative clock.
  pub(crate) fn write_video(
    &mut self,
    pts_100ns: i64,
    annex_b: &[u8],
    keyframe: bool,
  ) -> Result<(), String> {
    if self.videos.is_empty() && !keyframe {
      return Err("first video sample must be a keyframe".into());
    }
    if self
      .videos
      .last()
      .is_some_and(|sample| pts_100ns <= sample.pts)
    {
      return Err("video pts must increase between samples".into());
    }
    let nals = annex_b_nals(annex_b)?;
    let mut data = Vec::new();
    for nal in nals {
      match nal[0] & 0x1f {
        7 => {
          if self.sps.is_none() {
            self.sps = Some(nal.to_vec());
          }
        }
        8 => {
          if self.pps.is_none() {
            self.pps = Some(nal.to_vec());
          }
        }
        9 => {}
        _ => {
          let len = u32::try_from(nal.len()).map_err(|_| "video NAL exceeds MP4 size limit")?;
          data.extend_from_slice(&len.to_be_bytes());
          data.extend_from_slice(nal);
        }
      }
    }
    if self.videos.is_empty() && (self.sps.is_none() || self.pps.is_none()) {
      return Err("first video keyframe has no SPS and PPS".into());
    }
    if data.is_empty() {
      return Err("video access unit contains no sample NAL".into());
    }
    let size = u32::try_from(data.len()).map_err(|_| "video sample exceeds MP4 size limit")?;
    let offset = self
      .writer
      .stream_position()
      .map_err(|e| format!("locate video sample: {e}"))?;
    self
      .writer
      .write_all(&data)
      .map_err(|e| format!("write video sample: {e}"))?;
    self.videos.push(Sample {
      size,
      offset,
      pts: pts_100ns,
      keyframe,
    });
    Ok(())
  }

  /// Appends one Opus packet on the same file-relative clock as video.
  pub(crate) fn write_audio(&mut self, pts_100ns: i64, packet: &[u8]) -> Result<(), String> {
    if self.audio.is_none() {
      return Err("audio track was not configured".into());
    }
    if self
      .audios
      .last()
      .is_some_and(|sample| pts_100ns < sample.pts)
    {
      return Err("audio pts must not decrease between packets".into());
    }
    let size = u32::try_from(packet.len()).map_err(|_| "audio packet exceeds MP4 size limit")?;
    let offset = self
      .writer
      .stream_position()
      .map_err(|e| format!("locate audio packet: {e}"))?;
    self
      .writer
      .write_all(packet)
      .map_err(|e| format!("write audio packet: {e}"))?;
    self.audios.push(Sample {
      size,
      offset,
      pts: pts_100ns,
      keyframe: true,
    });
    Ok(())
  }

  /// Patches the 64-bit media size, writes the index, and flushes the writer.
  pub(crate) fn finish(mut self) -> Result<W, String> {
    let end = self
      .writer
      .stream_position()
      .map_err(|e| format!("locate end of MP4 media: {e}"))?;
    let mdat_size = end
      .checked_sub(self.mdat_start)
      .ok_or("MP4 media end precedes its header")?;
    self
      .writer
      .seek(SeekFrom::Start(self.mdat_start + 8))
      .and_then(|_| self.writer.write_all(&mdat_size.to_be_bytes()))
      .and_then(|_| self.writer.seek(SeekFrom::Start(end)).map(|_| ()))
      .map_err(|e| format!("patch MP4 mdat size: {e}"))?;
    let moov = self.moov()?;
    self
      .writer
      .write_all(&moov)
      .map_err(|e| format!("write MP4 moov: {e}"))?;
    self.writer.flush().map_err(|e| format!("flush MP4: {e}"))?;
    Ok(self.writer)
  }

  fn moov(&self) -> Result<Vec<u8>, String> {
    let video_durations = video_durations(&self.videos)?;
    let audio_durations = audio_durations(&self.audios)?;
    let video_duration = sum_durations(&video_durations)?;
    let audio_duration = sum_durations(&audio_durations)?;
    let video_ms = scale_duration(video_duration, 90_000, 1_000)?;
    let audio_ms = scale_duration(audio_duration, 48_000, 1_000)?;
    let has_video = !self.videos.is_empty();
    let has_audio = has_video && self.audio.is_some() && !self.audios.is_empty();
    let movie_ms = if has_video {
      video_ms.max(if has_audio { audio_ms } else { 0 })
    } else {
      0
    };
    let mut children = vec![mvhd(
      movie_ms,
      if has_audio {
        3
      } else if has_video {
        2
      } else {
        1
      },
    )?];
    if !self.videos.is_empty() {
      let sps = self.sps.as_deref().ok_or("video track has no SPS")?;
      let pps = self.pps.as_deref().ok_or("video track has no PPS")?;
      children.push(video_trak(
        &self.video,
        &self.videos,
        &video_durations,
        video_duration,
        video_ms,
        sps,
        pps,
      )?);
    }
    if let Some(audio) = self.audio.as_ref().filter(|_| has_audio) {
      children.push(audio_trak(
        audio,
        &self.audios,
        &audio_durations,
        audio_duration,
        audio_ms,
      )?);
    }
    boxed(*b"moov", concat(&children))
  }
}

fn annex_b_nals(data: &[u8]) -> Result<Vec<&[u8]>, String> {
  let mut starts = Vec::new();
  let mut i = 0;
  while i + 3 <= data.len() {
    let len = if data[i..].starts_with(&[0, 0, 0, 1]) {
      4
    } else if data[i..].starts_with(&[0, 0, 1]) {
      3
    } else {
      0
    };
    if len != 0 {
      starts.push((i, i + len));
      i += len;
    } else {
      i += 1;
    }
  }
  if starts.is_empty() || starts[0].0 != 0 {
    return Err("video access unit has no leading Annex B start code".into());
  }
  let mut nals = Vec::new();
  for (index, &(_, start)) in starts.iter().enumerate() {
    let mut end = starts.get(index + 1).map_or(data.len(), |next| next.0);
    if index + 1 < starts.len() {
      while end > start && data[end - 1] == 0 {
        end -= 1;
      }
    }
    if end == start {
      return Err("video access unit contains an empty NAL".into());
    }
    nals.push(&data[start..end]);
  }
  Ok(nals)
}

fn video_durations(samples: &[Sample]) -> Result<Vec<u32>, String> {
  let mut durations = Vec::with_capacity(samples.len());
  for pair in samples.windows(2) {
    let delta = pair[1]
      .pts
      .checked_sub(pair[0].pts)
      .ok_or("video pts span exceeds i64")?;
    durations.push(
      u32::try_from(((delta as u64 as u128) * 90_000 + 5_000_000) / 10_000_000)
        .map_err(|_| "video sample duration exceeds MP4 limit")?
        .max(1),
    );
  }
  if !samples.is_empty() {
    durations.push(*durations.last().unwrap_or(&3_000));
  }
  Ok(durations)
}

fn audio_durations(samples: &[Sample]) -> Result<Vec<u32>, String> {
  let mut durations = Vec::with_capacity(samples.len());
  for pair in samples.windows(2) {
    let delta = pair[1]
      .pts
      .checked_sub(pair[0].pts)
      .ok_or("audio pts span exceeds i64")?;
    let ticks = ((delta as u64 as u128) * 48_000 + 5_000_000) / 10_000_000;
    let packets = ((ticks + 480) / 960).max(1);
    durations
      .push(u32::try_from(packets * 960).map_err(|_| "audio sample duration exceeds MP4 limit")?);
  }
  if !samples.is_empty() {
    durations.push(*durations.last().unwrap_or(&960));
  }
  Ok(durations)
}

fn sum_durations(durations: &[u32]) -> Result<u32, String> {
  durations.iter().try_fold(0_u32, |sum, &duration| {
    sum
      .checked_add(duration)
      .ok_or_else(|| "track duration exceeds MP4 limit".into())
  })
}

fn scale_duration(duration: u32, from: u64, to: u64) -> Result<u32, String> {
  u32::try_from((duration as u64 * to + from / 2) / from)
    .map_err(|_| "movie duration exceeds MP4 limit".into())
}

fn concat(boxes: &[Vec<u8>]) -> Vec<u8> {
  boxes.iter().flat_map(|item| item.iter().copied()).collect()
}
fn boxed(kind: [u8; 4], body: Vec<u8>) -> Result<Vec<u8>, String> {
  let size = u32::try_from(body.len())
    .ok()
    .and_then(|n| n.checked_add(8))
    .ok_or("MP4 metadata box exceeds 32-bit size")?;
  let mut out = Vec::with_capacity(body.len() + 8);
  out.extend_from_slice(&size.to_be_bytes());
  out.extend_from_slice(&kind);
  out.extend_from_slice(&body);
  Ok(out)
}
fn full(version: u8, flags: u32, mut body: Vec<u8>) -> Vec<u8> {
  let mut out = vec![
    version,
    (flags >> 16) as u8,
    (flags >> 8) as u8,
    flags as u8,
  ];
  out.append(&mut body);
  out
}
fn u16be(out: &mut Vec<u8>, value: u16) {
  out.extend_from_slice(&value.to_be_bytes());
}
fn u32be(out: &mut Vec<u8>, value: u32) {
  out.extend_from_slice(&value.to_be_bytes());
}
fn u64be(out: &mut Vec<u8>, value: u64) {
  out.extend_from_slice(&value.to_be_bytes());
}
fn zeros(out: &mut Vec<u8>, count: usize) {
  out.resize(out.len() + count, 0);
}
fn matrix(out: &mut Vec<u8>) {
  for value in [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000] {
    u32be(out, value);
  }
}
fn ftyp() -> Vec<u8> {
  b"\0\0\0\x20ftypisom\0\0\x02\0isomiso2avc1mp41".to_vec()
}
fn mvhd(duration: u32, next_id: u32) -> Result<Vec<u8>, String> {
  let mut b = Vec::new();
  zeros(&mut b, 8);
  u32be(&mut b, 1_000);
  u32be(&mut b, duration);
  u32be(&mut b, 0x10000);
  u16be(&mut b, 0x100);
  zeros(&mut b, 10);
  matrix(&mut b);
  zeros(&mut b, 24);
  u32be(&mut b, next_id);
  boxed(*b"mvhd", full(0, 0, b))
}
fn tkhd(id: u32, duration_ms: u32, video: Option<&VideoTrack>) -> Result<Vec<u8>, String> {
  let mut b = Vec::new();
  zeros(&mut b, 8);
  u32be(&mut b, id);
  zeros(&mut b, 4);
  u32be(&mut b, duration_ms);
  zeros(&mut b, 8);
  u16be(&mut b, 0);
  u16be(&mut b, 0);
  u16be(&mut b, if video.is_some() { 0 } else { 0x100 });
  u16be(&mut b, 0);
  matrix(&mut b);
  u32be(&mut b, video.map_or(0, |v| v.width << 16));
  u32be(&mut b, video.map_or(0, |v| v.height << 16));
  boxed(*b"tkhd", full(0, 7, b))
}
fn mdhd(timescale: u32, duration: u32) -> Result<Vec<u8>, String> {
  let mut b = Vec::new();
  zeros(&mut b, 8);
  u32be(&mut b, timescale);
  u32be(&mut b, duration);
  u16be(&mut b, 0x55c4);
  u16be(&mut b, 0);
  boxed(*b"mdhd", full(0, 0, b))
}
fn hdlr(kind: [u8; 4], name: &[u8]) -> Result<Vec<u8>, String> {
  let mut b = Vec::new();
  zeros(&mut b, 4);
  b.extend_from_slice(&kind);
  zeros(&mut b, 12);
  b.extend_from_slice(name);
  b.push(0);
  boxed(*b"hdlr", full(0, 0, b))
}
fn dinf() -> Result<Vec<u8>, String> {
  let url = boxed(*b"url ", full(0, 1, Vec::new()))?;
  let mut dref = Vec::new();
  u32be(&mut dref, 1);
  dref.extend_from_slice(&url);
  boxed(*b"dinf", boxed(*b"dref", full(0, 0, dref))?)
}
fn stts(durations: &[u32]) -> Result<Vec<u8>, String> {
  let mut runs: Vec<(u32, u32)> = Vec::new();
  for &duration in durations {
    if let Some(last) = runs.last_mut().filter(|entry| entry.1 == duration) {
      last.0 = last
        .0
        .checked_add(1)
        .ok_or("sample run exceeds MP4 limit")?;
    } else {
      runs.push((1, duration));
    }
  }
  let mut b = Vec::new();
  u32be(
    &mut b,
    u32::try_from(runs.len()).map_err(|_| "too many duration runs")?,
  );
  for (count, duration) in runs {
    u32be(&mut b, count);
    u32be(&mut b, duration);
  }
  boxed(*b"stts", full(0, 0, b))
}
fn stsc() -> Result<Vec<u8>, String> {
  let mut b = Vec::new();
  u32be(&mut b, 1);
  u32be(&mut b, 1);
  u32be(&mut b, 1);
  u32be(&mut b, 1);
  boxed(*b"stsc", full(0, 0, b))
}
fn stsz(samples: &[Sample]) -> Result<Vec<u8>, String> {
  let mut b = Vec::new();
  u32be(&mut b, 0);
  u32be(
    &mut b,
    u32::try_from(samples.len()).map_err(|_| "too many samples")?,
  );
  for sample in samples {
    u32be(&mut b, sample.size);
  }
  boxed(*b"stsz", full(0, 0, b))
}
fn co64(samples: &[Sample]) -> Result<Vec<u8>, String> {
  let mut b = Vec::new();
  u32be(
    &mut b,
    u32::try_from(samples.len()).map_err(|_| "too many chunks")?,
  );
  for sample in samples {
    u64be(&mut b, sample.offset);
  }
  boxed(*b"co64", full(0, 0, b))
}
fn stss(samples: &[Sample]) -> Result<Vec<u8>, String> {
  let mut b = Vec::new();
  u32be(
    &mut b,
    u32::try_from(samples.iter().filter(|s| s.keyframe).count())
      .map_err(|_| "too many keyframes")?,
  );
  for (index, sample) in samples.iter().enumerate() {
    if sample.keyframe {
      u32be(
        &mut b,
        u32::try_from(index + 1).map_err(|_| "keyframe index exceeds MP4 limit")?,
      );
    }
  }
  boxed(*b"stss", full(0, 0, b))
}
fn video_stsd(video: &VideoTrack, sps: &[u8], pps: &[u8]) -> Result<Vec<u8>, String> {
  if sps.len() < 4 {
    return Err("SPS is too short for avcC profile fields".into());
  }
  let mut avcc = vec![1, sps[1], sps[2], sps[3], 0xff, 0xe1];
  u16be(
    &mut avcc,
    u16::try_from(sps.len()).map_err(|_| "SPS exceeds avcC size limit")?,
  );
  avcc.extend_from_slice(sps);
  avcc.push(1);
  u16be(
    &mut avcc,
    u16::try_from(pps.len()).map_err(|_| "PPS exceeds avcC size limit")?,
  );
  avcc.extend_from_slice(pps);
  let mut entry = Vec::new();
  zeros(&mut entry, 6);
  u16be(&mut entry, 1);
  zeros(&mut entry, 16);
  u16be(&mut entry, video.width as u16);
  u16be(&mut entry, video.height as u16);
  u32be(&mut entry, 72 << 16);
  u32be(&mut entry, 72 << 16);
  u32be(&mut entry, 0);
  u16be(&mut entry, 1);
  zeros(&mut entry, 32);
  u16be(&mut entry, 0x18);
  u16be(&mut entry, 0xffff);
  entry.extend_from_slice(&boxed(*b"avcC", avcc)?);
  let mut b = Vec::new();
  u32be(&mut b, 1);
  b.extend_from_slice(&boxed(*b"avc1", entry)?);
  boxed(*b"stsd", full(0, 0, b))
}
fn audio_stsd(audio: &AudioTrack) -> Result<Vec<u8>, String> {
  let mut dops = vec![0, audio.channels as u8];
  if audio.channels > u8::MAX as u16 {
    return Err("Opus channel count exceeds dOps limit".into());
  }
  u16be(&mut dops, 312);
  u32be(&mut dops, 48_000);
  u16be(&mut dops, 0);
  dops.push(0);
  let mut entry = Vec::new();
  zeros(&mut entry, 6);
  u16be(&mut entry, 1);
  zeros(&mut entry, 8);
  u16be(&mut entry, audio.channels);
  u16be(&mut entry, 16);
  u16be(&mut entry, 0);
  u16be(&mut entry, 0);
  u32be(&mut entry, 48_000 << 16);
  entry.extend_from_slice(&boxed(*b"dOps", dops)?);
  let mut b = Vec::new();
  u32be(&mut b, 1);
  b.extend_from_slice(&boxed(*b"Opus", entry)?);
  boxed(*b"stsd", full(0, 0, b))
}
fn video_trak(
  video: &VideoTrack,
  samples: &[Sample],
  durations: &[u32],
  duration: u32,
  ms: u32,
  sps: &[u8],
  pps: &[u8],
) -> Result<Vec<u8>, String> {
  let stbl = boxed(
    *b"stbl",
    concat(&[
      video_stsd(video, sps, pps)?,
      stts(durations)?,
      stss(samples)?,
      stsc()?,
      stsz(samples)?,
      co64(samples)?,
    ]),
  )?;
  let vmhd = boxed(*b"vmhd", full(0, 1, vec![0; 8]))?;
  let minf = boxed(*b"minf", concat(&[vmhd, dinf()?, stbl]))?;
  let mdia = boxed(
    *b"mdia",
    concat(&[
      mdhd(90_000, duration)?,
      hdlr(*b"vide", b"VideoHandler")?,
      minf,
    ]),
  )?;
  boxed(*b"trak", concat(&[tkhd(1, ms, Some(video))?, mdia]))
}
fn audio_trak(
  audio: &AudioTrack,
  samples: &[Sample],
  durations: &[u32],
  duration: u32,
  ms: u32,
) -> Result<Vec<u8>, String> {
  let stbl = boxed(
    *b"stbl",
    concat(&[
      audio_stsd(audio)?,
      stts(durations)?,
      stsc()?,
      stsz(samples)?,
      co64(samples)?,
    ]),
  )?;
  let smhd = boxed(*b"smhd", full(0, 0, vec![0; 4]))?;
  let minf = boxed(*b"minf", concat(&[smhd, dinf()?, stbl]))?;
  let mdia = boxed(
    *b"mdia",
    concat(&[
      mdhd(48_000, duration)?,
      hdlr(*b"soun", b"SoundHandler")?,
      minf,
    ]),
  )?;
  boxed(*b"trak", concat(&[tkhd(2, ms, None)?, mdia]))
}

#[cfg(test)]
mod tests {
  use super::*;
  use openh264::encoder::{Encoder, EncoderConfig, FrameType};
  use openh264::formats::{BgraSliceU8, YUVBuffer};
  use openh264::OpenH264API;
  use std::fs::File;
  use std::io::Read;
  use std::path::{Path, PathBuf};
  use std::sync::atomic::{AtomicUsize, Ordering};

  static NEXT_FILE: AtomicUsize = AtomicUsize::new(0);
  const SILENCE: &[u8] = &[0xF8, 0xFF, 0xFE];

  fn path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
      "velocity-mp4-writer-{name}-{}-{}.mp4",
      std::process::id(),
      NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    ))
  }

  fn frame(width: usize, height: usize, index: usize) -> Vec<u8> {
    let mut pixels = vec![0; width * height * 4];
    for (pixel_index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
      pixel[0] = ((pixel_index % width + index) % 256) as u8;
      pixel[1] = ((pixel_index / width) % 256) as u8;
      pixel[2] = ((pixel_index + index) % 256) as u8;
    }
    pixels
  }

  fn write_frames(path: &Path, width: u32, height: u32, count: usize, with_audio: bool) {
    let mut encoder =
      Encoder::with_api_config(OpenH264API::from_source(), EncoderConfig::new()).unwrap();
    let mut yuv = YUVBuffer::new(width as usize, height as usize);
    let file = File::create(path).unwrap();
    let mut writer = Mp4Writer::new(
      file,
      VideoTrack { width, height },
      with_audio.then_some(AudioTrack { channels: 2 }),
    )
    .unwrap();
    let mut audio_index = 0;
    for index in 0..count {
      let pixels = frame(width as usize, height as usize, index);
      yuv.read_bgra8(BgraSliceU8::new(&pixels, (width as usize, height as usize)));
      let encoded = encoder.encode(&yuv).unwrap();
      writer
        .write_video(
          index as i64 * 333_333,
          &encoded.to_vec(),
          encoded.frame_type() == FrameType::IDR,
        )
        .unwrap();
      while with_audio && audio_index as i64 * 200_000 < (index as i64 + 1) * 333_333 {
        writer
          .write_audio(audio_index as i64 * 200_000, SILENCE)
          .unwrap();
        audio_index += 1;
      }
    }
    writer.finish().unwrap();
  }

  #[test]
  fn real_h264_video_has_sixty_samples_and_a_keyframe() {
    let path = path("video");
    write_frames(&path, 64, 48, 60, false);
    let mut reader = mp4::read_mp4(File::open(&path).unwrap()).unwrap();
    assert_eq!(reader.tracks().len(), 1);
    let track = reader.tracks().values().next().unwrap();
    assert_eq!(track.media_type().unwrap(), mp4::MediaType::H264);
    assert_eq!((track.width(), track.height()), (64, 48));
    assert_eq!(track.sample_count(), 60);
    let track_id = track.track_id();
    assert!(reader.read_sample(track_id, 1).unwrap().unwrap().is_sync);
    assert!((reader.duration().as_secs_f64() - 2.0).abs() < 1.0 / 30.0);
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn interleaved_opus_has_expected_packet_count() {
    let path = path("audio");
    write_frames(&path, 64, 48, 60, true);
    let reader = mp4::read_mp4(File::open(&path).unwrap()).unwrap();
    let audio = reader
      .tracks()
      .values()
      .find(|track| track.track_type().unwrap() == mp4::TrackType::Audio)
      .unwrap();
    assert_eq!(audio.sample_count(), 100);
    assert_eq!(reader.tracks().len(), 2);
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn media_grows_before_finish_and_uses_a_64_bit_mdat_size() {
    let path = path("stream");
    let file = File::create(&path).unwrap();
    let mut writer = Mp4Writer::new(
      file,
      VideoTrack {
        width: 64,
        height: 48,
      },
      None,
    )
    .unwrap();
    let header_len = std::fs::metadata(&path).unwrap().len();
    let first = [
      0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0xaa, 0, 0, 0, 1, 0x68, 0xce, 0x06, 0xe2, 0, 0, 0, 1, 0x65,
      0x80,
    ];
    writer.write_video(0, &first, true).unwrap();
    let after_first = std::fs::metadata(&path).unwrap().len();
    writer
      .write_video(333_333, &[0, 0, 0, 1, 0x41, 0x80], false)
      .unwrap();
    let after_second = std::fs::metadata(&path).unwrap().len();
    assert!(header_len < after_first && after_first < after_second);
    writer.finish().unwrap();
    let mut file = File::open(&path).unwrap();
    let mut header = [0; 48];
    file.read_exact(&mut header).unwrap();
    assert_eq!(&header[32..36], &1_u32.to_be_bytes());
    assert_eq!(&header[36..40], b"mdat");
    assert_eq!(
      u64::from_be_bytes(header[40..48].try_into().unwrap()),
      after_second - 32
    );
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn first_non_keyframe_and_non_increasing_video_pts_are_errors() {
    let mut writer = Mp4Writer::new(
      std::io::Cursor::new(Vec::new()),
      VideoTrack {
        width: 64,
        height: 48,
      },
      None,
    )
    .unwrap();
    assert!(writer
      .write_video(0, &[0, 0, 0, 1, 0x41, 0x80], false)
      .is_err());
    let first = [
      0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0, 0, 0, 1, 0x68, 0xce, 0, 0, 0, 1, 0x65, 0x80,
    ];
    writer.write_video(0, &first, true).unwrap();
    assert!(writer
      .write_video(0, &[0, 0, 0, 1, 0x41, 0x80], false)
      .is_err());
    assert!(writer
      .write_video(-1, &[0, 0, 0, 1, 0x41, 0x80], false)
      .is_err());
  }

  #[test]
  fn no_video_finishes_with_an_empty_movie() {
    let path = path("empty");
    let file = File::create(&path).unwrap();
    let writer = Mp4Writer::new(
      file,
      VideoTrack {
        width: 64,
        height: 48,
      },
      None,
    )
    .unwrap();
    writer.finish().unwrap();
    let reader = mp4::read_mp4(File::open(&path).unwrap()).unwrap();
    assert!(reader.tracks().is_empty());
    let _ = std::fs::remove_file(path);
  }

  #[test]
  #[ignore]
  fn writes_a_streamed_sample_for_inspection() {
    let path = std::env::temp_dir().join("velocity-mp4-writer-sample.mp4");
    write_frames(&path, 320, 240, 60, true);
  }
}
