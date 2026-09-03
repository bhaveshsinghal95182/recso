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

/// One file feeding the mix.
struct MixSource {
  decoder: AudioDecoder,
  offset_ms: f64,
  /// A chunk decoded but belonging past the window being filled.
  ///
  /// Sources are read forward until they overshoot, and the frame that
  /// overshoots has to be kept rather than dropped -- it is the first frame of
  /// the *next* window.
  pending: Option<(f64, AudioChunk)>,
  exhausted: bool,
}

/// Mixes any number of audio files onto the edit's timeline, a window at a time.
///
/// Windowed rather than buffering the whole soundtrack: a stereo float mix of
/// an hour is over a gigabyte, and the mediabunny path is being retired partly
/// because it read whole files into memory. Replacing one memory ceiling with
/// another would be a poor trade.
///
/// The window is only the *output* granularity. Internally there is a small
/// accumulator ahead of it, because a decoded chunk is typically tens of
/// milliseconds and lands across a window boundary as often as not -- writing
/// only the part that fits would clip a slice out of the sound at every
/// boundary.
pub struct AudioMixer {
  sources: Vec<MixSource>,
  cuts: CutTrack,
  /// Mixed samples from `base_frame` onward, interleaved and still growing.
  accumulator: Vec<f32>,
  /// Composition frames already emitted.
  base_frame: u64,
}

/// How far past the requested window to decode before stopping.
///
/// Covers a chunk that starts inside the window and runs past its end. A
/// quarter second is many times the size of any decoder's output block.
const LOOKAHEAD_MS: f64 = 250.0;

impl AudioMixer {
  /// Open every source that has audio. `None` when none of them do.
  ///
  /// Each entry is a path and the offset that puts it on the screen
  /// recording's clock -- a camera sidecar that started late is placed by its
  /// offset, not by assuming both started together.
  pub fn open(sources: &[(String, f64)], cuts: CutTrack) -> Result<Option<Self>> {
    let mut opened = Vec::new();

    for (path, offset_ms) in sources {
      // A file with no audio, or one nothing can decode, is skipped rather than
      // failing the export: a recording with the microphone off is still a
      // recording.
      match AudioDecoder::open(path) {
        Ok(Some(decoder)) => opened.push(MixSource {
          decoder,
          offset_ms: *offset_ms,
          pending: None,
          exhausted: false,
        }),
        Ok(None) => {}
        Err(error) => {
          eprintln!("[engine] audio source {path} did not open: {error:?}");
        }
      }
    }

    if opened.is_empty() {
      return Ok(None);
    }

    Ok(Some(Self {
      sources: opened,
      cuts,
      accumulator: Vec::new(),
      base_frame: 0,
    }))
  }

  pub fn source_count(&self) -> usize {
    self.sources.len()
  }

  /// Discard everything before `composition_ms` and start the mix there.
  ///
  /// For an export trimmed to start partway in. Each source is sought in *its*
  /// own time, which is not the same number: the edit's clock has had the cuts
  /// taken out of it, and a sidecar has its own offset on top of that.
  pub fn skip_to(&mut self, composition_ms: f64) -> Result<()> {
    if composition_ms <= 0.0 {
      return Ok(());
    }

    let source_ms = self.cuts.to_source(composition_ms);
    for source in &mut self.sources {
      let at = ((source_ms - source.offset_ms).max(0.0) * 10_000.0) as i64;
      // A seek that fails leaves the decoder where it was, which reads as
      // audio that starts too early rather than not at all -- worth reporting
      // but not worth failing the export over.
      if let Err(error) = source.decoder.seek(at) {
        eprintln!("[engine] audio source could not seek: {error:?}");
      }
      source.pending = None;
      source.exhausted = false;
    }

    self.base_frame = (composition_ms / 1000.0 * MIX_SAMPLE_RATE as f64).round() as u64;
    self.accumulator.clear();
    Ok(())
  }

  /// The next `frames` of mixed audio, in composition time.
  ///
  /// Always returns exactly `frames * MIX_CHANNELS` samples: silence where no
  /// source has anything, so the audio timeline never develops a hole that the
  /// muxer would have to guess about.
  pub fn next_window(&mut self, frames: usize) -> Vec<f32> {
    if frames == 0 {
      return Vec::new();
    }

    let channels = MIX_CHANNELS as usize;
    let horizon_ms = frame_to_ms(self.base_frame + frames as u64) + LOOKAHEAD_MS;

    for index in 0..self.sources.len() {
      self.fill_from(index, horizon_ms);
    }

    let wanted = frames * channels;
    if self.accumulator.len() < wanted {
      self.accumulator.resize(wanted, 0.0);
    }

    let out: Vec<f32> = self.accumulator.drain(..wanted).collect();
    self.base_frame += frames as u64;
    out
  }

  /// Read one source forward until it passes `horizon_ms`.
  fn fill_from(&mut self, index: usize, horizon_ms: f64) {
    loop {
      let source = &mut self.sources[index];

      // Whatever overshot last time is this window's first chunk.
      let next = match source.pending.take() {
        Some(held) => Some(held),
        None => {
          if source.exhausted {
            None
          } else {
            match source.decoder.read_chunk() {
              Ok(chunk) if chunk.end_of_stream => {
                source.exhausted = true;
                None
              }
              Ok(chunk) => {
                let source_ms = chunk.timestamp_100ns as f64 / 10_000.0;
                let placement = SourcePlacement {
                  cuts: &self.cuts,
                  offset_ms: source.offset_ms,
                };
                // A chunk inside a cut is dropped and reading continues; it
                // belongs to a stretch of the edit nobody will hear.
                match placement.place(source_ms) {
                  Some(at_ms) => Some((at_ms, chunk)),
                  None => continue,
                }
              }
              Err(_) => {
                source.exhausted = true;
                None
              }
            }
          }
        }
      };

      let Some((at_ms, chunk)) = next else {
        return;
      };

      if at_ms >= horizon_ms {
        self.sources[index].pending = Some((at_ms, chunk));
        return;
      }

      let channels = self.sources[index].decoder.channels;
      accumulate(&mut self.accumulator, self.base_frame, &chunk, channels, at_ms);
    }
  }
}

fn frame_to_ms(frame: u64) -> f64 {
  frame as f64 / MIX_SAMPLE_RATE as f64 * 1000.0
}

/// Sum a chunk into a growing accumulator whose first frame is `base_frame`.
///
/// Grows as needed rather than dropping the tail: unlike `MixBuffer`, which has
/// a fixed length because it represents the whole edit, this one is a sliding
/// view and its far edge is not a real boundary.
fn accumulate(dst: &mut Vec<f32>, base_frame: u64, chunk: &AudioChunk, channels: u32, at_ms: f64) {
  if chunk.samples.is_empty() || channels == 0 {
    return;
  }

  let source_channels = channels as usize;
  let out_channels = MIX_CHANNELS as usize;
  let chunk_frames = chunk.samples.len() / source_channels;
  let start = (at_ms / 1000.0 * MIX_SAMPLE_RATE as f64).round() as i64 - base_frame as i64;

  for frame in 0..chunk_frames {
    let target = start + frame as i64;
    if target < 0 {
      continue;
    }
    let target = target as usize;

    let needed = (target + 1) * out_channels;
    if dst.len() < needed {
      dst.resize(needed, 0.0);
    }

    let source_base = frame * source_channels;
    let target_base = target * out_channels;
    for channel in 0..out_channels {
      let source_index = if source_channels == 1 {
        source_base
      } else {
        source_base + channel.min(source_channels - 1)
      };
      dst[target_base + channel] += chunk.samples[source_index];
    }
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
  fn a_stereo_chunk_lands_where_it_is_placed() {
    let mut dst = Vec::new();
    // One frame of full-scale stereo, half a second into the window.
    accumulate(&mut dst, 0, &chunk(0.0, vec![1.0, -1.0]), 2, 500.0);

    let frame = MIX_SAMPLE_RATE as usize / 2;
    assert_eq!(dst[frame * 2], 1.0);
    assert_eq!(dst[frame * 2 + 1], -1.0);
    // And silence in front of it, not a smeared copy.
    assert_eq!(dst[0], 0.0);
  }

  #[test]
  fn a_mono_chunk_is_heard_on_both_sides() {
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(0.0, vec![0.5]), 1, 0.0);

    assert_eq!(dst[0], 0.5);
    assert_eq!(dst[1], 0.5);
  }

  #[test]
  fn sources_sum_rather_than_replace() {
    // The whole point of a mixer: two sources at the same instant are heard
    // together, not one instead of the other.
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(0.0, vec![0.3, 0.3]), 2, 0.0);
    accumulate(&mut dst, 0, &chunk(0.0, vec![0.4, 0.4]), 2, 0.0);

    assert!((dst[0] - 0.7).abs() < 1e-6);
  }

  #[test]
  fn the_accumulator_grows_rather_than_truncating_a_tail() {
    // The failure this guards against: a chunk that starts inside a window and
    // runs past its end, written only as far as the window reaches. That
    // removes a slice of sound at every window boundary -- a regular tick
    // through the whole export, which is far more audible than the gap's size
    // suggests.
    let mut dst = Vec::new();
    let samples = vec![0.5f32; 1000];
    accumulate(&mut dst, 0, &chunk(0.0, samples), 1, 0.0);

    assert_eq!(dst.len(), 1000 * MIX_CHANNELS as usize);
    assert!(dst.iter().all(|s| (*s - 0.5).abs() < 1e-6));
  }

  #[test]
  fn the_accumulator_places_relative_to_its_base_frame() {
    let mut dst = Vec::new();
    // A window starting one second in, and a chunk one second in: it belongs at
    // the accumulator's frame zero, not at its second-worth offset.
    accumulate(
      &mut dst,
      MIX_SAMPLE_RATE as u64,
      &chunk(0.0, vec![1.0, 1.0]),
      2,
      1000.0,
    );

    assert_eq!(dst[0], 1.0);
  }

  #[test]
  fn the_accumulator_drops_what_falls_before_its_base() {
    let mut dst = Vec::new();
    // Half a second of audio placed at zero, while the window starts at one
    // second: entirely behind, and none of it should appear at frame zero.
    let samples = vec![1.0f32; MIX_SAMPLE_RATE as usize / 2];
    accumulate(
      &mut dst,
      MIX_SAMPLE_RATE as u64,
      &chunk(0.0, samples),
      1,
      0.0,
    );

    assert!(dst.is_empty() || dst.iter().all(|s| *s == 0.0));
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
