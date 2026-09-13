//! Hardware H.264 encode straight from D3D11 textures, muxed to MP4.
//!
//! Uses IMFSinkWriter, which owns both the encoder MFT and the MP4 muxer. Doing
//! it by hand would mean driving the MFT and an IMFMediaSink separately for no
//! benefit at this stage.

use windows::core::{Interface, Result, PCWSTR};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12;
use windows::Win32::Media::MediaFoundation::*;

use crate::engine::d3d::gpu;
use crate::engine::mf::{device_manager, ensure_mf, wide};

/// How many staging textures to rotate through.
///
/// The encoder holds a reference to a submitted frame until it has consumed it.
/// Writing into a texture that is still queued corrupts the output, so we cycle
/// through a small ring instead of reusing one.
const RING: usize = 6;

fn pack(hi: u32, lo: u32) -> u64 {
  ((hi as u64) << 32) | lo as u64
}

// The encoder only takes NV12. Feeding the sink writer RGB32 and letting it
// insert a video processor looks tempting, but it fails with E_INVALIDARG on
// the second frame, so the render layer converts back to NV12 itself.

/// The audio stream to add alongside the video, if there is any sound.
///
/// Separate from the encoder's own fields because it is optional and fixed at
/// creation: `BeginWriting` closes the set of streams, so an audio track cannot
/// be added to a writer that has already started.
#[derive(Clone, Copy)]
pub struct AudioSpec {
  pub sample_rate: u32,
  pub channels: u32,
  /// Bits per second for the AAC stream. 128k is transparent enough for a
  /// screen recording's narration and system sound.
  pub bitrate: u32,
}

impl Default for AudioSpec {
  fn default() -> Self {
    Self {
      sample_rate: 48_000,
      channels: 2,
      bitrate: 128_000,
    }
  }
}

pub struct Encoder {
  writer: IMFSinkWriter,
  stream: u32,
  /// The audio stream index, when the output has sound.
  audio_stream: Option<u32>,
  audio: AudioSpec,
  /// Frames of audio written so far, which is what timestamps are derived
  /// from. Counting rather than trusting a clock keeps the audio and the
  /// container's timeline exactly in step.
  audio_frames_written: u64,
  ring: Vec<ID3D11Texture2D>,
  next: usize,
  pub width: u32,
  pub height: u32,
  /// Kept as a rational. 29.97 is 30000/1001, and rounding it to 30 makes the
  /// output drift about a second per hour.
  pub fps_num: u32,
  pub fps_den: u32,
  pub frames_written: u64,
  finished: bool,
}

unsafe impl Send for Encoder {}

impl Encoder {
  pub fn create(
    path: &str,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    bitrate: u32,
  ) -> Result<Self> {
    Self::create_with_audio(path, width, height, fps_num, fps_den, bitrate, None)
  }

  /// As `create`, plus an AAC stream for `audio`.
  ///
  /// The audio stream has to be declared here rather than added later:
  /// `BeginWriting` fixes the set of streams, and it is called before this
  /// returns.
  #[allow(clippy::too_many_arguments)]
  pub fn create_with_audio(
    path: &str,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    bitrate: u32,
    audio: Option<AudioSpec>,
  ) -> Result<Self> {
    ensure_mf();
    let gpu = gpu()?;
    let (manager, _token) = device_manager()?;

    let attrs = unsafe { create_attributes(4)? };
    unsafe {
      attrs.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, manager)?;
      // Without this the sink writer picks a software encoder.
      attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
      // Throttling paces writes to real time, which is exactly wrong for export.
      attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
    }

    let url = wide(path);
    let writer =
      unsafe { MFCreateSinkWriterFromURL(PCWSTR(url.as_ptr()), None, &attrs)? };

    // What lands in the file.
    let out = unsafe { MFCreateMediaType()? };
    unsafe {
      out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
      out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
      out.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
      out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
      out.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
      out.SetUINT64(&MF_MT_FRAME_RATE, pack(fps_num, fps_den))?;
      out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
    }
    let stream = unsafe { writer.AddStream(&out)? };

    // What we feed it: NV12, either straight from a decoder or from the render
    // layer's conversion pass.
    let input = unsafe { MFCreateMediaType()? };
    unsafe {
      input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
      input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
      input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
      input.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
      input.SetUINT64(&MF_MT_FRAME_RATE, pack(fps_num, fps_den))?;
      input.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
      writer.SetInputMediaType(stream, &input, None)?;
    }

    // Staging textures the encoder reads from.

    let mut ring = Vec::with_capacity(RING);
    for _ in 0..RING {
      let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
          Count: 1,
          Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
      };
      let mut tex: Option<ID3D11Texture2D> = None;
      unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut tex))? };
      ring.push(tex.expect("staging texture"));
    }

    // ---- audio -------------------------------------------------------------
    //
    // AAC, fed 16-bit PCM. The encoder MFT does not accept float, so the mix is
    // converted on the way in -- which is also the point where it is clamped,
    // since a sum of sources can exceed full scale and the conversion would
    // wrap rather than saturate.
    let audio_spec = audio.unwrap_or_default();
    let audio_stream = match audio {
      None => None,
      Some(spec) => {
        let block_align = spec.channels * 2;

        let out = unsafe { MFCreateMediaType()? };
        unsafe {
          out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
          out.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
          out.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
          out.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, spec.sample_rate)?;
          out.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, spec.channels)?;
          out.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, spec.bitrate / 8)?;
          // 0 is raw AAC, which is what an MP4 wants. The alternative, ADTS,
          // carries its own framing and would end up nested in the container.
          out.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)?;
        }
        let index = unsafe { writer.AddStream(&out)? };

        let input = unsafe { MFCreateMediaType()? };
        unsafe {
          input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
          input.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
          input.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
          input.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, spec.sample_rate)?;
          input.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, spec.channels)?;
          input.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, block_align)?;
          input.SetUINT32(
            &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
            spec.sample_rate * block_align,
          )?;
          input.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
          writer.SetInputMediaType(index, &input, None)?;
        }

        Some(index)
      }
    };

    unsafe { writer.BeginWriting()? };

    Ok(Self {
      writer,
      stream,
      audio_stream,
      audio: audio_spec,
      audio_frames_written: 0,
      ring,
      next: 0,
      width,
      height,
      fps_num,
      fps_den,
      frames_written: 0,
      finished: false,
    })
  }

  /// Copy a GPU texture into the ring and submit it to the encoder.
  ///
  /// `src_subresource` matters because decoder output is a texture array.
  pub fn write_texture(
    &mut self,
    src: &ID3D11Texture2D,
    src_subresource: u32,
  ) -> Result<()> {
    let gpu = gpu()?;
    let slot = self.ring[self.next].clone();
    self.next = (self.next + 1) % RING;

    {
      let _guard = crate::engine::d3d::render_lock();
      unsafe {
        gpu
          .context
          .CopySubresourceRegion(&slot, 0, 0, 0, 0, src, src_subresource, None);
        gpu.context.Flush();
      }
    }
    crate::engine::d3d::wait_for_gpu_if_requested()?;

    // Wrap the texture as an MF buffer. No copy to system memory happens here;
    // the encoder reads the surface directly.
    let buffer: IMFMediaBuffer = unsafe {
      MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &slot, 0, false)?
    };

    // The buffer starts with length 0. An encoder handed a zero-length buffer
    // silently writes nothing, so this line is load-bearing.
    let len = unsafe { buffer.cast::<IMF2DBuffer>()?.GetContiguousLength()? };
    unsafe { buffer.SetCurrentLength(len)? };

    let sample = unsafe { MFCreateSample()? };
    // 100ns units per frame, from the rational rate.
    let ticks_per_frame =
      (10_000_000i64 * self.fps_den as i64) / self.fps_num.max(1) as i64;
    unsafe {
      sample.AddBuffer(&buffer)?;
      sample.SetSampleTime(self.frames_written as i64 * ticks_per_frame)?;
      sample.SetSampleDuration(ticks_per_frame)?;
      self.writer.WriteSample(self.stream, &sample)?;
    }

    self.frames_written += 1;
    Ok(())
  }

  /// Flush the encoder and close the MP4. Without this the file has no moov
  /// atom and nothing will play it.
  /// Write interleaved float samples to the audio stream.
  ///
  /// Timestamps come from a running frame count rather than from the caller:
  /// audio is continuous, so the only way for it to stay in step with the
  /// container is for every sample written to advance the clock by exactly its
  /// own duration. A caller passing timestamps could leave gaps that the muxer
  /// would fill with silence, or overlaps it would resolve by guessing.
  ///
  /// Samples are clamped on the way to 16-bit. A sum of sources can exceed full
  /// scale, and the float-to-integer conversion wraps rather than saturating --
  /// so an un-clamped loud moment comes out as a full-amplitude click of the
  /// opposite sign, which is far more audible than the clipping it replaces.
  pub fn write_audio(&mut self, samples: &[f32]) -> Result<()> {
    let Some(stream) = self.audio_stream else {
      return Ok(());
    };
    if samples.is_empty() {
      return Ok(());
    }

    let channels = self.audio.channels.max(1) as usize;
    let frames = samples.len() / channels;
    if frames == 0 {
      return Ok(());
    }

    let bytes = samples.len() * 2;

    unsafe {
      let buffer = MFCreateMemoryBuffer(bytes as u32)?;

      let mut data: *mut u8 = std::ptr::null_mut();
      buffer.Lock(&mut data, None, None)?;
      let out = std::slice::from_raw_parts_mut(data as *mut i16, samples.len());
      for (target, source) in out.iter_mut().zip(samples) {
        *target = (source.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
      }
      buffer.Unlock()?;
      buffer.SetCurrentLength(bytes as u32)?;

      let sample = MFCreateSample()?;
      sample.AddBuffer(&buffer)?;

      let rate = self.audio.sample_rate.max(1) as i64;
      let start = self.audio_frames_written as i64 * 10_000_000 / rate;
      let end = (self.audio_frames_written + frames as u64) as i64 * 10_000_000 / rate;
      sample.SetSampleTime(start)?;
      sample.SetSampleDuration(end - start)?;

      self.writer.WriteSample(stream, &sample)?;
    }

    self.audio_frames_written += frames as u64;
    Ok(())
  }

  /// Audio frames written so far, for progress and for checking the audio and
  /// video timelines came out the same length.
  pub fn audio_frames_written(&self) -> u64 {
    self.audio_frames_written
  }

  pub fn finish(&mut self) -> Result<()> {
    if !self.finished {
      unsafe { self.writer.Finalize()? };
      self.finished = true;
    }
    Ok(())
  }
}

impl Drop for Encoder {
  fn drop(&mut self) {
    let _ = self.finish();
  }
}

/// `MFCreateAttributes` takes an out-param; this just makes call sites readable.
unsafe fn create_attributes(count: u32) -> Result<IMFAttributes> {
  let mut attrs: Option<IMFAttributes> = None;
  unsafe { MFCreateAttributes(&mut attrs, count)? };
  Ok(attrs.expect("attributes"))
}

#[cfg(test)]
mod packing_scenarios {
  use super::*;

  #[test]
  fn packing_puts_the_first_half_in_the_high_word() {
    assert_eq!(pack(1, 0), 1u64 << 32);
  }

  #[test]
  fn packing_puts_the_second_half_in_the_low_word() {
    assert_eq!(pack(0, 1), 1);
  }

  #[test]
  fn packing_zeroes_is_zero() {
    assert_eq!(pack(0, 0), 0);
  }

  #[test]
  fn the_two_halves_do_not_bleed_into_each_other() {
    // Which is the whole point: a width of 1920 and a height of 1080 have to
    // come back out as 1920 and 1080, not as one number.
    let packed = pack(1920, 1080);
    assert_eq!((packed >> 32) as u32, 1920);
    assert_eq!(packed as u32, 1080);
  }

  #[test]
  fn a_full_width_low_half_does_not_reach_the_high_half() {
    let packed = pack(0, u32::MAX);
    assert_eq!(packed >> 32, 0);
    assert_eq!(packed as u32, u32::MAX);
  }

  #[test]
  fn a_full_width_high_half_does_not_reach_the_low_half() {
    let packed = pack(u32::MAX, 0);
    assert_eq!((packed >> 32) as u32, u32::MAX);
    assert_eq!(packed as u32, 0);
  }

  #[test]
  fn both_halves_at_full_width_fill_the_word() {
    assert_eq!(pack(u32::MAX, u32::MAX), u64::MAX);
  }

  #[test]
  fn packing_round_trips_for_every_pair_it_is_used_with() {
    let sizes = [
      (1920u32, 1080u32),
      (3840, 2160),
      (1280, 720),
      (1, 1),
      (0, 0),
      (48_000, 2),
    ];
    for (hi, lo) in sizes {
      let packed = pack(hi, lo);
      assert_eq!(((packed >> 32) as u32, packed as u32), (hi, lo), "{hi}/{lo}");
    }
  }

  #[test]
  fn swapping_the_arguments_gives_a_different_value() {
    assert_ne!(pack(1920, 1080), pack(1080, 1920));
  }

  #[test]
  fn the_default_audio_spec_is_forty_eight_kilohertz_stereo() {
    let spec = AudioSpec::default();
    assert_eq!(spec.sample_rate, 48_000);
    assert_eq!(spec.channels, 2);
  }

  #[test]
  fn the_default_audio_bitrate_is_transparent_enough_for_narration() {
    assert_eq!(AudioSpec::default().bitrate, 128_000);
  }

  #[test]
  fn the_default_audio_spec_matches_the_mixers_own_format() {
    // The mixer produces 48kHz stereo; a spec that disagreed would make the
    // sink writer resample every export for no reason.
    use crate::engine::audio::{MIX_CHANNELS, MIX_SAMPLE_RATE};
    let spec = AudioSpec::default();
    assert_eq!(spec.sample_rate, MIX_SAMPLE_RATE);
    assert_eq!(spec.channels, MIX_CHANNELS);
  }
}
