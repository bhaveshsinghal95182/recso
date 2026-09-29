//! Encodes raw PipeWire pixels into H.264 and writes a regular MP4.
//! The capture thread drives this synchronous API frame by frame.
//!
//! H.264 comes from openh264 on the CPU, or from NVENC on an NVIDIA GPU.

use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

use super::mp4_writer::{AudioTrack, Mp4Writer, VideoTrack};
use super::nvenc::{NvencEncoder, NvencSettings};
use openh264::encoder::{
  BitRate, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, RateControlMode,
  UsageType,
};
use openh264::formats::{BgraSliceU8, RgbaSliceU8, YUVBuffer};
use openh264::{OpenH264API, Timestamp};

/// PipeWire pixel byte order; the fourth byte is ignored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PixelOrder {
  /// Blue, green, red, unused.
  Bgrx,
  /// Red, green, blue, unused.
  Rgbx,
}

/// Requested video parameters; odd dimensions are rounded down for YUV420.
#[derive(Clone, Copy, Debug)]
pub(crate) struct VideoSettings {
  /// Requested width in pixels.
  pub(crate) width: u32,
  /// Requested height in pixels.
  pub(crate) height: u32,
  /// Rate control target and keyframe cadence.
  pub(crate) fps: u32,
  /// Rate control target in bits per second.
  pub(crate) bitrate: u32,
}

/// Which H.264 encoder a recorder uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EncoderChoice {
  /// NVENC when the machine has it, openh264 otherwise.
  Auto,
  /// NVENC, or an error.
  Hardware,
  /// openh264 on the CPU.
  Software,
}

/// Opus is fixed at 48 kHz, leaving only channel count to configure.
#[derive(Clone, Copy, Debug)]
pub(crate) struct AudioSettings {
  /// Number of channels.
  pub(crate) channels: u16,
}

/// Reports samples actually muxed, excluding rate-control skips.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RecorderSummary {
  /// Nonempty video samples in the file.
  pub(crate) frames_written: u64,
  /// Video frames with a non-increasing timestamp.
  pub(crate) frames_dropped: u64,
  /// Video span plus one nominal frame period, in 100 ns units.
  pub(crate) duration_100ns: i64,
  /// Actual even encoded width.
  pub(crate) width: u32,
  /// Actual even encoded height.
  pub(crate) height: u32,
}

enum VideoEncoder {
  Software { encoder: Encoder, yuv: YUVBuffer },
  Nvenc(NvencEncoder),
}

/// Reuses its conversion buffers while the caller feeds it frames.
pub(crate) struct Mp4Recorder {
  video: VideoEncoder,
  encoder_name: String,
  muxer: Mp4Writer<BufWriter<File>>,
  sync_file: File,
  packed: Vec<u8>,
  width: u32,
  height: u32,
  fps: u32,
  has_audio: bool,
  first_written_pts: Option<i64>,
  last_written_pts: Option<i64>,
  last_audio_pts: Option<i64>,
  frames_written: u64,
  frames_dropped: u64,
}

/// Copies a frame into `packed`, the output size at a tight stride: cropped
/// where the frame is larger, black where it is smaller.
fn pack(
  packed: &mut [u8],
  pixels: &[u8],
  frame_width: u32,
  frame_height: u32,
  stride: usize,
  width: u32,
  height: u32,
) {
  packed.fill(0);
  let copy_bytes = frame_width.min(width) as usize * 4;
  let output_stride = width as usize * 4;
  for row in 0..frame_height.min(height) as usize {
    let source = row * stride;
    let target = row * output_stride;
    packed[target..target + copy_bytes].copy_from_slice(&pixels[source..source + copy_bytes]);
  }
}

/// openh264, tuned for screen content.
fn software_encoder(
  video: VideoSettings,
  interval: u32,
  width: u32,
  height: u32,
) -> Result<(VideoEncoder, String), String> {
  let config = EncoderConfig::new()
    .bitrate(BitRate::from_bps(video.bitrate))
    .max_frame_rate(FrameRate::from_hz(video.fps as f32))
    .usage_type(UsageType::ScreenContentRealTime)
    .rate_control_mode(RateControlMode::Bitrate)
    .adaptive_quantization(false)
    .background_detection(false)
    // A screen recording must keep every frame it is given: the capture is
    // already variable-rate, and a skipped frame is a visible stutter.
    .skip_frames(false)
    .intra_frame_period(IntraFramePeriod::from_num_frames(interval));
  let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)
    .map_err(|e| format!("create H.264 encoder: {e}"))?;
  let yuv = YUVBuffer::new(width as usize, height as usize);
  Ok((VideoEncoder::Software { encoder, yuv }, "openh264 (CPU)".into()))
}

impl Mp4Recorder {
  /// Creates a non-fragmented MP4 suitable for browser playback, encoded by
  /// openh264.
  pub(crate) fn create(
    path: &Path,
    video: VideoSettings,
    audio: Option<AudioSettings>,
  ) -> Result<Self, String> {
    Self::create_with(path, video, audio, EncoderChoice::Software)
  }

  /// Like `create`, with the H.264 encoder picked by `choice`.
  pub(crate) fn create_with(
    path: &Path,
    video: VideoSettings,
    audio: Option<AudioSettings>,
    choice: EncoderChoice,
  ) -> Result<Self, String> {
    let width = video.width & !1;
    let height = video.height & !1;
    if width == 0 || height == 0 {
      return Err("video width and height must be at least 2 after rounding to even".into());
    }
    if video.fps == 0 {
      return Err("video fps must be greater than zero".into());
    }
    let interval = video
      .fps
      .checked_mul(2)
      .ok_or("fps is too large for a two-second keyframe interval")?;
    let packed_len = (width as usize)
      .checked_mul(height as usize)
      .and_then(|n| n.checked_mul(4))
      .ok_or("video dimensions are too large")?;
    if width > i32::MAX as u32 || height > i32::MAX as u32 {
      return Err("video dimensions exceed the encoder limit".into());
    }
    let nvenc = || NvencEncoder::new(NvencSettings {
      width,
      height,
      fps: video.fps,
      bitrate: video.bitrate,
    });
    let (video_encoder, encoder_name) = match choice {
      EncoderChoice::Software => software_encoder(video, interval, width, height)?,
      EncoderChoice::Hardware => {
        let encoder = nvenc().map_err(|e| format!("open the GPU encoder (NVENC): {e}"))?;
        let name = format!("NVENC on {}", encoder.device_name());
        (VideoEncoder::Nvenc(encoder), name)
      }
      EncoderChoice::Auto => match nvenc() {
        Ok(encoder) => {
          let name = format!("NVENC on {}", encoder.device_name());
          (VideoEncoder::Nvenc(encoder), name)
        }
        Err(error) => {
          eprintln!("[velocity] no GPU encoder ({error}); encoding in software");
          software_encoder(video, interval, width, height)?
        }
      },
    };
    let file = File::create(path).map_err(|e| format!("create {}: {e}", path.display()))?;
    let sync_file = file
      .try_clone()
      .map_err(|e| format!("clone {} for flushing: {e}", path.display()))?;
    let muxer = Mp4Writer::new(
      BufWriter::new(file),
      VideoTrack { width, height },
      audio.map(|settings| AudioTrack { channels: settings.channels }),
    )
    .map_err(|e| format!("create MP4 muxer: {e}"))?;
    Ok(Self {
      video: video_encoder,
      encoder_name,
      muxer,
      sync_file,
      packed: vec![0; packed_len],
      width,
      height,
      fps: video.fps,
      has_audio: audio.is_some(),
      first_written_pts: None,
      last_written_pts: None,
      last_audio_pts: None,
      frames_written: 0,
      frames_dropped: 0,
    })
  }

  /// Pads non-overlapping output pixels with black; duplicate timestamps are
  /// dropped because the MP4 sample table requires strictly increasing video PTS.
  pub(crate) fn push_frame(
    &mut self,
    pixels: &[u8],
    frame_width: u32,
    frame_height: u32,
    stride: usize,
    order: PixelOrder,
    pts_100ns: i64,
  ) -> Result<(), String> {
    let source_row = (frame_width as usize)
      .checked_mul(4)
      .ok_or("frame width overflows byte count")?;
    let source_len = stride
      .checked_mul(frame_height as usize)
      .ok_or("frame size overflows byte count")?;
    if stride < source_row || pixels.len() < source_len {
      return Err("frame buffer is shorter than its dimensions or stride require".into());
    }
    // Checked before encoding, not after: an encoded frame becomes the
    // reference for the next one, and a reference that never reaches the file
    // corrupts every frame decoded against it until the next keyframe.
    if self.last_written_pts.is_some_and(|last| pts_100ns <= last) {
      self.frames_dropped += 1;
      return Ok(());
    }
    // Rate control paces itself by these timestamps; without them it assumes
    // frames arrive at a fixed rate and misjudges a variable-rate capture.
    let origin = self.first_written_pts.unwrap_or(pts_100ns);
    let encoder_time = Timestamp::from_millis(
      u64::try_from(pts_100ns.saturating_sub(origin) / 10_000).unwrap_or(0),
    );
    let output_stride = self.width as usize * 4;
    let fits = frame_width == self.width && frame_height == self.height;
    let (data, keyframe) = match &mut self.video {
      VideoEncoder::Nvenc(encoder) => {
        // NVENC reads RGBA rows at any stride, so a frame that already has the
        // output size goes to the GPU as it is.
        let encoded = if fits && order == PixelOrder::Rgbx {
          encoder.encode(pixels, stride, false)
        } else {
          pack(&mut self.packed, pixels, frame_width, frame_height, stride, self.width, self.height);
          if order == PixelOrder::Bgrx {
            self.packed.chunks_exact_mut(4).for_each(|pixel| pixel.swap(0, 2));
          }
          encoder.encode(&self.packed, output_stride, false)
        }
        .map_err(|e| format!("encode video frame: {e}"))?;
        (encoded.annex_b, encoded.keyframe)
      }
      VideoEncoder::Software { encoder, yuv } => {
        let source = if fits && stride == output_stride {
          &pixels[..output_stride * self.height as usize]
        } else {
          pack(&mut self.packed, pixels, frame_width, frame_height, stride, self.width, self.height);
          &self.packed[..]
        };
        let size = (self.width as usize, self.height as usize);
        match order {
          PixelOrder::Bgrx => yuv.read_bgra8(BgraSliceU8::new(source, size)),
          PixelOrder::Rgbx => yuv.read_rgba8(RgbaSliceU8::new(source, size)),
        }
        let (mut data, mut keyframe) = {
          let encoded = encoder
            .encode_at(&*yuv, encoder_time)
            .map_err(|e| format!("encode video frame: {e}"))?;
          (encoded.to_vec(), encoded.frame_type() == FrameType::IDR)
        };
        // The initial encode normally initializes the encoder with an IDR. If it
        // does not, force one after initialization before handing it to the muxer.
        if !data.is_empty() && self.first_written_pts.is_none() && !keyframe {
          encoder.force_intra_frame();
          let encoded = encoder
            .encode_at(&*yuv, encoder_time)
            .map_err(|e| format!("encode first keyframe: {e}"))?;
          data = encoded.to_vec();
          keyframe = encoded.frame_type() == FrameType::IDR;
          if !data.is_empty() && !keyframe {
            return Err("encoder did not produce an IDR for the first video frame".into());
          }
        }
        (data, keyframe)
      }
    };
    if data.is_empty() {
      return Ok(());
    }
    let relative = pts_100ns
      .checked_sub(origin)
      .ok_or("video timestamp span exceeds i64")?;
    self
      .muxer
      .write_video(relative, &data, keyframe)
      .map_err(|e| format!("write video sample: {e}"))?;
    self.first_written_pts.get_or_insert(pts_100ns);
    self.last_written_pts = Some(pts_100ns);
    self.frames_written += 1;
    Ok(())
  }

  /// The encoder in use, named for the user.
  pub(crate) fn encoder_name(&self) -> &str {
    &self.encoder_name
  }

  /// Discards audio predating the first video sample, which establishes the
  /// shared clock origin, and audio older than the last written packet.
  pub(crate) fn push_audio_packet(&mut self, packet: &[u8], pts_100ns: i64) -> Result<(), String> {
    if !self.has_audio {
      return Err("audio track was not configured".into());
    }
    let Some(origin) = self.first_written_pts else {
      return Ok(());
    };
    if pts_100ns < origin || self.last_audio_pts.is_some_and(|last| pts_100ns < last) {
      return Ok(());
    }
    let relative = pts_100ns
      .checked_sub(origin)
      .ok_or("audio timestamp span exceeds i64")?;
    self
      .muxer
      .write_audio(relative, packet)
      .map_err(|e| format!("write audio sample: {e}"))?;
    self.last_audio_pts = Some(pts_100ns);
    Ok(())
  }

  /// Finalizes the container even when no video sample was recorded.
  pub(crate) fn finish(self) -> Result<RecorderSummary, String> {
    let Self {
      muxer,
      sync_file,
      width,
      height,
      fps,
      first_written_pts,
      last_written_pts,
      frames_written,
      frames_dropped,
      ..
    } = self;
    drop(muxer.finish().map_err(|e| format!("finalize MP4: {e}"))?);
    // The consumed writer drops its BufWriter before returning. Sync the same
    // open file afterward so storage errors surface before reporting success.
    sync_file
      .sync_all()
      .map_err(|e| format!("flush MP4 file: {e}"))?;
    let (Some(first), Some(last)) = (first_written_pts, last_written_pts) else {
      return Err("no video frames were recorded".into());
    };
    let duration_100ns = last
      .checked_sub(first)
      .and_then(|span| span.checked_add(10_000_000 / fps as i64))
      .ok_or("video duration exceeds i64")?;
    Ok(RecorderSummary {
      frames_written,
      frames_dropped,
      duration_100ns,
      width,
      height,
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use mp4::{MediaType, TrackType};
  use std::path::PathBuf;
  use std::sync::atomic::{AtomicUsize, Ordering};

  static NEXT_FILE: AtomicUsize = AtomicUsize::new(0);
  const OPUS_SILENCE: &[u8] = &[0xF8, 0xFF, 0xFE];

  fn path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
      "velocity-encoder-{name}-{}-{}.mp4",
      std::process::id(),
      NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    ))
  }

  fn settings(width: u32, height: u32) -> VideoSettings {
    VideoSettings {
      width,
      height,
      fps: 30,
      bitrate: 2_000_000,
    }
  }

  fn gradient(width: u32, height: u32, index: u32) -> Vec<u8> {
    let mut bytes = vec![0; width as usize * height as usize * 4];
    for y in 0..height as usize {
      for x in 0..width as usize {
        let offset = (y * width as usize + x) * 4;
        bytes[offset] = ((x as u32 + index) % 256) as u8;
        bytes[offset + 1] = (y % 256) as u8;
        bytes[offset + 2] = ((x + y) % 256) as u8;
      }
    }
    bytes
  }

  fn read_video(path: &Path, expected_count: u32, width: u16, height: u16) {
    let reader = mp4::read_mp4(File::open(path).unwrap()).unwrap();
    let videos: Vec<_> = reader
      .tracks()
      .values()
      .filter(|track| track.track_type().unwrap() == TrackType::Video)
      .collect();
    assert_eq!(videos.len(), 1);
    assert_eq!(videos[0].media_type().unwrap(), MediaType::H264);
    assert_eq!((videos[0].width(), videos[0].height()), (width, height));
    assert_eq!(videos[0].sample_count(), expected_count);
  }

  #[test]
  fn thirty_gradient_frames_make_a_playable_h264_track() {
    let path = path("gradient");
    let mut recorder = Mp4Recorder::create(&path, settings(64, 48), None).unwrap();
    for index in 0..30 {
      let frame = gradient(64, 48, index);
      recorder
        .push_frame(
          &frame,
          64,
          48,
          64 * 4,
          PixelOrder::Bgrx,
          9_000_000_000 + index as i64 * 333_333,
        )
        .unwrap();
    }
    let summary = recorder.finish().unwrap();
    read_video(&path, 30, 64, 48);
    let reader = mp4::read_mp4(File::open(&path).unwrap()).unwrap();
    assert!((reader.duration().as_secs_f64() - 1.0).abs() < 1.0 / 30.0);
    assert_eq!(summary.frames_written, 30);
    assert_eq!(summary.frames_dropped, 0);
    assert_eq!((summary.width, summary.height), (64, 48));
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn odd_requested_dimensions_are_rounded_down() {
    let path = path("odd");
    let mut recorder = Mp4Recorder::create(&path, settings(65, 49), None).unwrap();
    recorder
      .push_frame(&gradient(65, 49, 0), 65, 49, 65 * 4, PixelOrder::Bgrx, 0)
      .unwrap();
    let summary = recorder.finish().unwrap();
    read_video(&path, 1, 64, 48);
    assert_eq!((summary.width, summary.height), (64, 48));
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn padded_rows_and_rgbx_pixels_encode_without_missing_samples() {
    let path = path("stride");
    let mut recorder = Mp4Recorder::create(&path, settings(64, 48), None).unwrap();
    let mut padded = vec![0; (64 * 4 + 64) * 48];
    for index in 0..3 {
      let frame = gradient(64, 48, index);
      for row in 0..48 {
        let source = row * 64 * 4;
        let target = row * (64 * 4 + 64);
        padded[target..target + 64 * 4].copy_from_slice(&frame[source..source + 64 * 4]);
      }
      recorder
        .push_frame(
          &padded,
          64,
          48,
          64 * 4 + 64,
          PixelOrder::Rgbx,
          index as i64 * 333_333,
        )
        .unwrap();
    }
    recorder.finish().unwrap();
    read_video(&path, 3, 64, 48);
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn equal_video_timestamp_is_counted_as_dropped() {
    let path = path("duplicate");
    let mut recorder = Mp4Recorder::create(&path, settings(64, 48), None).unwrap();
    let frame = gradient(64, 48, 0);
    for pts in [0, 0, 333_333] {
      recorder
        .push_frame(&frame, 64, 48, 64 * 4, PixelOrder::Bgrx, pts)
        .unwrap();
    }
    let summary = recorder.finish().unwrap();
    assert_eq!((summary.frames_written, summary.frames_dropped), (2, 1));
    read_video(&path, 2, 64, 48);
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn larger_and_smaller_source_frames_are_cropped_and_padded() {
    let path = path("resize");
    let mut recorder = Mp4Recorder::create(&path, settings(64, 48), None).unwrap();
    for (index, (width, height)) in [(80, 60), (32, 24), (64, 48)].into_iter().enumerate() {
      recorder
        .push_frame(
          &gradient(width, height, index as u32),
          width,
          height,
          width as usize * 4,
          PixelOrder::Bgrx,
          index as i64 * 333_333,
        )
        .unwrap();
    }
    recorder.finish().unwrap();
    read_video(&path, 3, 64, 48);
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn malformed_frame_buffers_return_errors_without_poisoning_recorder() {
    let path = path("short");
    let mut recorder = Mp4Recorder::create(&path, settings(64, 48), None).unwrap();
    assert!(recorder
      .push_frame(&[0; 8], 64, 48, 256, PixelOrder::Bgrx, 0)
      .is_err());
    assert!(recorder
      .push_frame(&[0; 48], 64, 48, 1, PixelOrder::Bgrx, 0)
      .is_err());
    recorder
      .push_frame(&gradient(64, 48, 0), 64, 48, 256, PixelOrder::Bgrx, 0)
      .unwrap();
    recorder.finish().unwrap();
    read_video(&path, 1, 64, 48);
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn opus_audio_is_muxed_after_the_first_video_frame() {
    let path = path("audio");
    let mut recorder =
      Mp4Recorder::create(&path, settings(64, 48), Some(AudioSettings { channels: 2 })).unwrap();
    let origin = 9_000_000_000_i64;
    recorder
      .push_audio_packet(OPUS_SILENCE, origin - 200_000)
      .unwrap();
    for index in 0..10 {
      recorder
        .push_frame(
          &gradient(64, 48, index),
          64,
          48,
          256,
          PixelOrder::Bgrx,
          origin + index as i64 * 333_333,
        )
        .unwrap();
      for audio_index in 0..2 {
        recorder
          .push_audio_packet(
            OPUS_SILENCE,
            origin + (index * 2 + audio_index) as i64 * 200_000,
          )
          .unwrap();
      }
    }
    recorder.finish().unwrap();
    let reader = mp4::read_mp4(File::open(&path).unwrap()).unwrap();
    assert_eq!(reader.tracks().len(), 2);
    assert_eq!(
      reader
        .tracks()
        .values()
        .filter(|track| track.track_type().unwrap() == TrackType::Audio)
        .count(),
      1
    );
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn zero_video_frames_return_an_error_after_finalization() {
    let path = path("empty");
    let recorder = Mp4Recorder::create(&path, settings(64, 48), None).unwrap();
    assert!(recorder.finish().is_err());
    let _ = std::fs::remove_file(path);
  }

  #[test]
  #[ignore]
  fn writes_a_sample_for_manual_inspection() {
    let path = std::env::temp_dir().join("velocity-encoder-sample.mp4");
    let mut recorder = Mp4Recorder::create(
      &path,
      settings(320, 240),
      Some(AudioSettings { channels: 2 }),
    )
    .unwrap();
    for index in 0..60 {
      recorder
        .push_frame(
          &gradient(320, 240, index),
          320,
          240,
          320 * 4,
          PixelOrder::Bgrx,
          index as i64 * 333_333,
        )
        .unwrap();
    }
    for index in 0..100 {
      recorder
        .push_audio_packet(OPUS_SILENCE, index as i64 * 200_000)
        .unwrap();
    }
    recorder.finish().unwrap();
  }
}
