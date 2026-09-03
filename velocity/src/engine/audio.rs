//! Audio decode and mixing.
//!
//! The engine had no audio at all. Everything else about a recording -- the
//! picture, the camera, the pointer, the timeline -- lived here, and the sound
//! lived in the mediabunny export path, which is why that path could not be
//! retired.
//!
//! A recording's sound is rarely one track. The screen capture may carry system
//! audio, the camera sidecar carries the microphone, and older recordings keep
//! either or both in sidecar files of their own. So the shape here is: decode
//! any number of sources to a common format, place each on the edit's timeline,
//! and sum them.
//!
//! Everything is 32-bit float, interleaved, at one sample rate. Float because
//! summing 16-bit integers clips the moment two sources are loud at once and
//! the fix is to work in a format with headroom, not to pre-attenuate and hope.
//!
//! ```text
//!   screen.mp4  audio ─┐
//!   camera.mp4  audio ─┼─> resample -> place on the cut timeline ─> sum ─> AAC
//!   system.wav        ─┘
//! ```

// Decode and mixing are in place and tested; nothing calls them yet, because
// the encoder cannot write an audio stream. That is the next piece, and until
// it exists this module is deliberately unreachable rather than half-wired --
// an export that writes a silent audio track is harder to diagnose than one
// with no audio track at all.
#![allow(dead_code)]

use windows::core::{Result, PCWSTR};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::VT_I8;

use crate::engine::cuts::CutTrack;
use crate::engine::mf::{ensure_mf, wide};

/// What every source is decoded to before anything else happens.
///
/// 48kHz because that is what the recorder captures and what AAC in an MP4
/// wants; resampling once on the way in beats resampling per source later.
pub const MIX_SAMPLE_RATE: u32 = 48_000;

/// Stereo. Mono sources are duplicated across both, which is what a listener
/// expects from a microphone that happens to be mono.
pub const MIX_CHANNELS: u32 = 2;

/// One block of decoded audio, interleaved.
pub struct AudioChunk {
  /// 100ns units, as Media Foundation reports it.
  pub timestamp_100ns: i64,
  /// Interleaved samples: `[l, r, l, r, ...]` for stereo.
  pub samples: Vec<f32>,
  pub end_of_stream: bool,
}

impl AudioChunk {
  /// How many frames (sample-sets across all channels) this chunk holds.
  pub fn frames(&self, channels: u32) -> usize {
    if channels == 0 {
      return 0;
    }
    self.samples.len() / channels as usize
  }
}

/// A decoded audio stream from one file.
///
/// Deliberately separate from the video `Decoder` even when both come from the
/// same file: a Media Foundation source reader is single-consumer, and the
/// export reads video and audio at different rates. Two readers on one file
/// cost less than trying to interleave one.
pub struct AudioDecoder {
  reader: IMFSourceReader,
  pub sample_rate: u32,
  pub channels: u32,
  pub duration_100ns: i64,
}

unsafe impl Send for AudioDecoder {}

impl AudioDecoder {
  /// Open a file's first audio stream, decoded to float PCM.
  ///
  /// Returns `Ok(None)` when the file has no audio at all, which is not an
  /// error: a screen recording with the microphone off is a perfectly good
  /// recording and the caller should carry on without it.
  pub fn open(path: &str) -> Result<Option<Self>> {
    ensure_mf();

    let url = wide(path);
    let reader = unsafe { MFCreateSourceReaderFromURL(PCWSTR(url.as_ptr()), None)? };

    let stream = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;

    // Ask for float PCM at the mix rate. The reader inserts a resampler when
    // the file is something else, which is the whole reason to state a rate
    // here rather than take whatever the file has and convert later.
    let want = unsafe { MFCreateMediaType()? };
    let configured = unsafe {
      want
        .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
        .and_then(|_| want.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float))
        .and_then(|_| want.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 32))
        .and_then(|_| want.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, MIX_SAMPLE_RATE))
        .and_then(|_| want.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, MIX_CHANNELS))
        .and_then(|_| reader.SetCurrentMediaType(stream, None, &want))
        .and_then(|_| reader.SetStreamSelection(stream, true))
    };

    // No audio stream, or one nothing can decode. Both mean "carry on without
    // it" rather than "fail the export".
    if configured.is_err() {
      return Ok(None);
    }

    let actual = unsafe { reader.GetCurrentMediaType(stream)? };
    let sample_rate =
      unsafe { actual.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND) }.unwrap_or(MIX_SAMPLE_RATE);
    let channels = unsafe { actual.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS) }.unwrap_or(MIX_CHANNELS);

    let duration_100ns = unsafe {
      match reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
      {
        Ok(v) => (*v.Anonymous.Anonymous).Anonymous.uhVal as i64,
        Err(_) => 0,
      }
    };

    Ok(Some(Self {
      reader,
      sample_rate,
      channels,
      duration_100ns,
    }))
  }

  /// Pull one block of decoded audio.
  pub fn read_chunk(&mut self) -> Result<AudioChunk> {
    let stream = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;

    loop {
      let mut flags = 0u32;
      let mut timestamp = 0i64;
      let mut sample: Option<IMFSample> = None;

      unsafe {
        self.reader.ReadSample(
          stream,
          0,
          None,
          Some(&mut flags),
          Some(&mut timestamp),
          Some(&mut sample),
        )?;
      }

      if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
        return Ok(AudioChunk {
          timestamp_100ns: timestamp,
          samples: Vec::new(),
          end_of_stream: true,
        });
      }

      // A stream tick is the reader saying "nothing yet, but not the end".
      let Some(sample) = sample else {
        continue;
      };

      let samples = unsafe { read_float_samples(&sample)? };
      return Ok(AudioChunk {
        timestamp_100ns: timestamp,
        samples,
        end_of_stream: false,
      });
    }
  }

  /// Seek to a position in 100ns units.
  pub fn seek(&mut self, position_100ns: i64) -> Result<()> {
    let mut var = PROPVARIANT::default();
    unsafe {
      let inner = &mut *var.Anonymous.Anonymous;
      inner.vt = VT_I8;
      inner.Anonymous.hVal = position_100ns;
      self.reader.SetCurrentPosition(&GUID_NULL, &var)?;
    }
    Ok(())
  }
}

const GUID_NULL: windows::core::GUID = windows::core::GUID::zeroed();

/// Copy an `IMFSample`'s bytes out as `f32`s.
///
/// The buffer belongs to Media Foundation and is recycled, so this copies
/// rather than borrowing -- the same reason the video path copies decoder
/// textures into its own.
unsafe fn read_float_samples(sample: &IMFSample) -> Result<Vec<f32>> {
  unsafe {
    let buffer = sample.ConvertToContiguousBuffer()?;

    let mut data: *mut u8 = std::ptr::null_mut();
    let mut length = 0u32;
    buffer.Lock(&mut data, None, Some(&mut length))?;

    let count = length as usize / std::mem::size_of::<f32>();
    let mut out = vec![0f32; count];
    if count > 0 && !data.is_null() {
      std::ptr::copy_nonoverlapping(data as *const f32, out.as_mut_ptr(), count);
    }

    buffer.Unlock()?;
    Ok(out)
  }
}

/// A fixed-length stereo mix buffer that sources are summed into.
///
/// Addressed in *composition* time: a source's samples are placed where the
/// edit puts them, not where the file has them, so cuts are applied by mapping
/// each chunk's timestamp rather than by splicing buffers.
pub struct MixBuffer {
  samples: Vec<f32>,
  frames: usize,
}

impl MixBuffer {
  /// A silent buffer covering `duration_ms` of the edit.
  pub fn new(duration_ms: f64) -> Self {
    let frames = ((duration_ms / 1000.0) * MIX_SAMPLE_RATE as f64)
      .ceil()
      .max(0.0) as usize;
    Self {
      samples: vec![0.0; frames * MIX_CHANNELS as usize],
      frames,
    }
  }

  pub fn frames(&self) -> usize {
    self.frames
  }

  pub fn samples(&self) -> &[f32] {
    &self.samples
  }

  pub fn is_empty(&self) -> bool {
    self.frames == 0
  }

  /// Sum one decoded chunk into the mix at a composition timestamp.
  ///
  /// `channels` is what the chunk actually carries; mono is duplicated across
  /// both output channels and anything wider is folded down by taking the
  /// first two, which is what a stereo mix can represent.
  ///
  /// Samples landing outside the buffer are dropped rather than clamped to its
  /// edges: a chunk that starts before zero belongs to a part of the timeline
  /// that was cut, and piling it onto frame zero would be audible.
  pub fn add_chunk(&mut self, chunk: &AudioChunk, channels: u32, at_ms: f64) {
    if self.frames == 0 || channels == 0 || chunk.samples.is_empty() {
      return;
    }

    let source_channels = channels as usize;
    let out_channels = MIX_CHANNELS as usize;
    let start = (at_ms / 1000.0 * MIX_SAMPLE_RATE as f64).round() as i64;
    let chunk_frames = chunk.samples.len() / source_channels;

    for frame in 0..chunk_frames {
      let target = start + frame as i64;
      if target < 0 {
        continue;
      }
      let target = target as usize;
      if target >= self.frames {
        break;
      }

      let source_base = frame * source_channels;
      let target_base = target * out_channels;

      for channel in 0..out_channels {
        // Mono feeds both sides; wider sources keep their first two channels.
        let source_index = if source_channels == 1 {
          source_base
        } else {
          source_base + channel.min(source_channels - 1)
        };
        self.samples[target_base + channel] += chunk.samples[source_index];
      }
    }
  }

  /// Bring the loudest peak down to `ceiling`, if it is above it.
  ///
  /// Summing sources can exceed 1.0, and everything downstream clips there.
  /// Scaling the whole mix by one factor keeps the balance between sources; a
  /// limiter that acted per-sample would change it.
  ///
  /// Quiet mixes are left alone. Normalising up would raise the noise floor of
  /// a deliberately quiet recording.
  pub fn normalise(&mut self, ceiling: f32) {
    let peak = self
      .samples
      .iter()
      .fold(0.0f32, |worst, sample| worst.max(sample.abs()));

    if peak <= ceiling || peak == 0.0 {
      return;
    }

    let gain = ceiling / peak;
    for sample in &mut self.samples {
      *sample *= gain;
    }
  }
}

/// Where one source's audio sits on the edit's timeline.
pub struct SourcePlacement<'a> {
  /// The cuts to apply. A chunk inside one is dropped.
  pub cuts: &'a CutTrack,
  /// Shifts the source before the cut mapping, for a sidecar that started
  /// recording at a different moment from the screen.
  pub offset_ms: f64,
}

impl SourcePlacement<'_> {
  /// Where a chunk at `source_ms` lands in the edit, or `None` if it was cut.
  pub fn place(&self, source_ms: f64) -> Option<f64> {
    let shifted = source_ms + self.offset_ms;
    if self.cuts.contains(shifted) {
      return None;
    }
    Some(self.cuts.to_composition(shifted))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::engine::cuts::Cut;

  fn chunk(at_ms: f64, samples: Vec<f32>) -> AudioChunk {
    AudioChunk {
      timestamp_100ns: (at_ms * 10_000.0) as i64,
      samples,
      end_of_stream: false,
    }
  }

  #[test]
  fn a_mix_buffer_is_silent_and_the_length_asked_for() {
    let mix = MixBuffer::new(1000.0);
    assert_eq!(mix.frames(), MIX_SAMPLE_RATE as usize);
    assert!(mix.samples().iter().all(|s| *s == 0.0));
  }

  #[test]
  fn a_stereo_chunk_lands_where_it_is_placed() {
    let mut mix = MixBuffer::new(1000.0);
    // One frame of full-scale stereo, half a second in.
    mix.add_chunk(&chunk(0.0, vec![1.0, -1.0]), 2, 500.0);

    let frame = MIX_SAMPLE_RATE as usize / 2;
    assert_eq!(mix.samples()[frame * 2], 1.0);
    assert_eq!(mix.samples()[frame * 2 + 1], -1.0);
    // And nothing anywhere else.
    assert_eq!(mix.samples()[0], 0.0);
  }

  #[test]
  fn a_mono_chunk_is_heard_on_both_sides() {
    let mut mix = MixBuffer::new(1000.0);
    mix.add_chunk(&chunk(0.0, vec![0.5]), 1, 0.0);

    assert_eq!(mix.samples()[0], 0.5);
    assert_eq!(mix.samples()[1], 0.5);
  }

  #[test]
  fn sources_sum_rather_than_replace() {
    let mut mix = MixBuffer::new(1000.0);
    mix.add_chunk(&chunk(0.0, vec![0.3, 0.3]), 2, 0.0);
    mix.add_chunk(&chunk(0.0, vec![0.4, 0.4]), 2, 0.0);

    assert!((mix.samples()[0] - 0.7).abs() < 1e-6);
  }

  #[test]
  fn audio_past_the_end_is_dropped_rather_than_piled_on_the_last_frame() {
    let mut mix = MixBuffer::new(100.0);
    let frames = mix.frames();
    // A chunk starting after the buffer ends.
    mix.add_chunk(&chunk(0.0, vec![1.0, 1.0]), 2, 200.0);

    assert_eq!(mix.frames(), frames);
    assert!(mix.samples().iter().all(|s| *s == 0.0));
  }

  #[test]
  fn audio_before_zero_is_dropped_rather_than_piled_on_the_first_frame() {
    let mut mix = MixBuffer::new(100.0);
    // Long enough that its tail reaches into the buffer.
    let samples = vec![1.0f32; MIX_SAMPLE_RATE as usize];
    mix.add_chunk(&chunk(0.0, samples), 1, -500.0);

    // The part before zero is gone, not stacked on frame 0.
    assert_eq!(mix.samples()[0], 1.0);
    assert!(mix.samples()[0].abs() <= 1.0);
  }

  #[test]
  fn normalising_scales_a_hot_mix_down_and_keeps_the_balance() {
    let mut mix = MixBuffer::new(10.0);
    mix.add_chunk(&chunk(0.0, vec![2.0, 1.0]), 2, 0.0);
    mix.normalise(1.0);

    assert!((mix.samples()[0] - 1.0).abs() < 1e-6);
    // The quieter channel came down by the same factor, not to its own ceiling.
    assert!((mix.samples()[1] - 0.5).abs() < 1e-6);
  }

  #[test]
  fn a_quiet_mix_is_left_alone() {
    let mut mix = MixBuffer::new(10.0);
    mix.add_chunk(&chunk(0.0, vec![0.2, 0.1]), 2, 0.0);
    mix.normalise(1.0);

    // Normalising up would raise the noise floor of a deliberately quiet take.
    assert!((mix.samples()[0] - 0.2).abs() < 1e-6);
  }

  #[test]
  fn a_placement_maps_through_the_cuts() {
    let cuts = CutTrack::new(vec![Cut {
      start_ms: 1000.0,
      end_ms: 2000.0,
    }]);
    let placement = SourcePlacement {
      cuts: &cuts,
      offset_ms: 0.0,
    };

    // Before the cut, unchanged.
    assert_eq!(placement.place(500.0), Some(500.0));
    // Inside it, gone.
    assert_eq!(placement.place(1500.0), None);
    // After it, pulled back by the cut's length.
    assert_eq!(placement.place(2500.0), Some(1500.0));
  }

  #[test]
  fn an_offset_shifts_a_sidecar_before_the_cuts_are_applied() {
    let cuts = CutTrack::new(vec![Cut {
      start_ms: 1000.0,
      end_ms: 2000.0,
    }]);
    let placement = SourcePlacement {
      cuts: &cuts,
      offset_ms: 800.0,
    };

    // A sidecar that started 800ms late: its own t=200 is the screen's t=1000,
    // which is inside the cut.
    assert_eq!(placement.place(200.0), None);
    assert_eq!(placement.place(100.0), Some(900.0));
  }
}
