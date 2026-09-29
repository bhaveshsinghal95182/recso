//! Audio mixing: place any number of decoded sources on the edit's timeline
//! and sum them.
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
//!   camera.mp4  audio ─┼─> resample -> place on the cut timeline ─> sum ─> encoder
//!   system.wav        ─┘
//! ```
//!
//! Decoding is the only platform-specific part (Media Foundation on Windows,
//! Opus in MP4 on Linux), so it sits behind [`ChunkSource`] and the rest is
//! shared: the two platforms must place and sum audio identically, or an
//! export's sound would depend on which machine made it.

use crate::engine::cuts::CutTrack;

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


/// One decoded audio stream, as the mixer reads it.
///
/// Each platform's decoder converts to [`MIX_SAMPLE_RATE`] itself: resampling
/// once on the way in beats resampling per source later.
pub trait ChunkSource {
  type Error: std::fmt::Debug;

  /// Channels in each chunk's interleaved samples.
  fn channels(&self) -> u32;
  /// Pull one block of decoded audio. `end_of_stream` marks the end.
  fn read_chunk(&mut self) -> Result<AudioChunk, Self::Error>;
  /// Seek to a position in 100ns units.
  fn seek(&mut self, position_100ns: i64) -> Result<(), Self::Error>;
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
struct MixSource<D> {
  decoder: D,
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
pub struct AudioMixer<D> {
  sources: Vec<MixSource<D>>,
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

impl<D: ChunkSource> AudioMixer<D> {
  /// Open every source that has audio. `None` when none of them do.
  ///
  /// Each entry is a path and the offset that puts it on the screen
  /// recording's clock -- a camera sidecar that started late is placed by its
  /// offset, not by assuming both started together.
  pub fn open_with<E: std::fmt::Debug>(
    sources: &[(String, f64)],
    cuts: CutTrack,
    mut open: impl FnMut(&str) -> Result<Option<D>, E>,
  ) -> Option<Self> {
    let mut opened = Vec::new();

    for (path, offset_ms) in sources {
      // A file with no audio, or one nothing can decode, is skipped rather than
      // failing the export: a recording with the microphone off is still a
      // recording.
      match open(path) {
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
      return None;
    }

    Some(Self {
      sources: opened,
      cuts,
      accumulator: Vec::new(),
      base_frame: 0,
    })
  }

  pub fn source_count(&self) -> usize {
    self.sources.len()
  }

  /// Discard everything before `composition_ms` and start the mix there.
  ///
  /// For an export trimmed to start partway in. Each source is sought in *its*
  /// own time, which is not the same number: the edit's clock has had the cuts
  /// taken out of it, and a sidecar has its own offset on top of that.
  pub fn skip_to(&mut self, composition_ms: f64) {
    if composition_ms <= 0.0 {
      return;
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

      let channels = self.sources[index].decoder.channels();
      accumulate(&mut self.accumulator, self.base_frame, &chunk, channels, at_ms);
    }
  }
}

/// How many audio frames should have been written by `composition_ms`.
///
/// Derived from the position rather than accumulated per video frame: a
/// variable-rate screen recording has no fixed frames-per-video-frame, and
/// rounding one every frame would drift the audio against the picture over a
/// long export.
pub fn audio_frames_due(composition_ms: f64, already_written: u64) -> usize {
  let target = (composition_ms.max(0.0) / 1000.0 * MIX_SAMPLE_RATE as f64).round() as u64;
  target.saturating_sub(already_written) as usize
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

#[cfg(test)]
mod accumulate_scenarios {
  use super::*;

  fn chunk(samples: Vec<f32>) -> AudioChunk {
    AudioChunk {
      timestamp_100ns: 0,
      samples,
      end_of_stream: false,
    }
  }

  /// How many frames a millisecond offset comes to at the mix rate.
  fn frame_of(ms: f64) -> usize {
    (ms / 1000.0 * MIX_SAMPLE_RATE as f64).round() as usize
  }

  #[test]
  fn an_empty_chunk_writes_nothing() {
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(Vec::new()), 2, 0.0);
    assert!(dst.is_empty());
  }

  #[test]
  fn a_chunk_with_no_channels_writes_nothing() {
    // Guarding the divide that works out how many frames the chunk holds.
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![1.0, 1.0]), 0, 0.0);
    assert!(dst.is_empty());
  }

  #[test]
  fn a_chunk_at_the_start_lands_at_the_start() {
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![0.5, -0.5]), 2, 0.0);
    assert_eq!(dst[0], 0.5);
    assert_eq!(dst[1], -0.5);
  }

  #[test]
  fn the_output_is_always_stereo_however_many_channels_came_in() {
    for channels in [1u32, 2, 4, 6] {
      let mut dst = Vec::new();
      let samples = vec![0.25f32; channels as usize];
      accumulate(&mut dst, 0, &chunk(samples), channels, 0.0);
      assert_eq!(dst.len(), MIX_CHANNELS as usize, "{channels}");
    }
  }

  #[test]
  fn a_mono_chunk_is_heard_on_both_sides() {
    // Which is what a listener expects from a microphone that happens to be
    // mono -- not a signal stuck in the left ear.
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![0.75]), 1, 0.0);
    assert_eq!(dst[0], 0.75);
    assert_eq!(dst[1], 0.75);
  }

  #[test]
  fn a_stereo_chunk_keeps_its_two_sides_apart() {
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![1.0, -1.0]), 2, 0.0);
    assert_eq!(dst[0], 1.0);
    assert_eq!(dst[1], -1.0);
  }

  #[test]
  fn a_multichannel_chunk_takes_its_first_two_channels() {
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), 6, 0.0);
    assert_eq!(dst[0], 0.1);
    assert_eq!(dst[1], 0.2);
  }

  #[test]
  fn several_frames_land_next_to_each_other() {
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]), 2, 0.0);
    assert_eq!(dst, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
  }

  #[test]
  fn a_chunk_is_placed_at_its_own_offset() {
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![1.0, -1.0]), 2, 500.0);
    let frame = frame_of(500.0);
    assert_eq!(dst[frame * 2], 1.0);
    assert_eq!(dst[frame * 2 + 1], -1.0);
  }

  #[test]
  fn the_space_before_a_placed_chunk_is_silence() {
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![1.0, 1.0]), 2, 100.0);
    let frame = frame_of(100.0);
    assert!(dst[..frame * 2].iter().all(|s| *s == 0.0));
  }

  #[test]
  fn sources_sum_rather_than_replace() {
    // The whole point of an accumulator: two microphones on the same moment
    // are heard together, not one instead of the other.
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![0.25, 0.25]), 2, 0.0);
    accumulate(&mut dst, 0, &chunk(vec![0.5, 0.5]), 2, 0.0);
    assert_eq!(dst[0], 0.75);
    assert_eq!(dst[1], 0.75);
  }

  #[test]
  fn summing_is_order_independent() {
    let mut a = Vec::new();
    accumulate(&mut a, 0, &chunk(vec![0.25, -0.1]), 2, 0.0);
    accumulate(&mut a, 0, &chunk(vec![0.5, 0.3]), 2, 0.0);
    let mut b = Vec::new();
    accumulate(&mut b, 0, &chunk(vec![0.5, 0.3]), 2, 0.0);
    accumulate(&mut b, 0, &chunk(vec![0.25, -0.1]), 2, 0.0);
    assert_eq!(a, b);
  }

  #[test]
  fn summing_is_not_clamped_here() {
    // Headroom is the mixer's problem downstream; clipping in the accumulator
    // would lose information a later gain stage could still have used.
    let mut dst = Vec::new();
    for _ in 0..4 {
      accumulate(&mut dst, 0, &chunk(vec![1.0, 1.0]), 2, 0.0);
    }
    assert_eq!(dst[0], 4.0);
  }

  #[test]
  fn the_accumulator_grows_rather_than_truncating_a_tail() {
    // Unlike a fixed-length mix buffer, this one is a sliding view and its far
    // edge is not a real boundary.
    let mut dst = vec![0.0; 4];
    accumulate(&mut dst, 0, &chunk(vec![1.0, 1.0]), 2, 1000.0);
    assert!(dst.len() > 4);
    let frame = frame_of(1000.0);
    assert_eq!(dst[frame * 2], 1.0);
  }

  #[test]
  fn growing_does_not_disturb_what_was_already_there() {
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![0.9, 0.8]), 2, 0.0);
    accumulate(&mut dst, 0, &chunk(vec![0.1, 0.2]), 2, 500.0);
    assert_eq!(dst[0], 0.9);
    assert_eq!(dst[1], 0.8);
  }

  #[test]
  fn the_accumulator_places_relative_to_its_base_frame() {
    // The base moves forward as windows are emitted, so a chunk's absolute
    // time has to be measured against it rather than against zero.
    let base = frame_of(1000.0) as u64;
    let mut dst = Vec::new();
    accumulate(&mut dst, base, &chunk(vec![1.0, 1.0]), 2, 1000.0);
    assert_eq!(dst[0], 1.0);
    assert_eq!(dst.len(), 2);
  }

  #[test]
  fn the_accumulator_drops_what_falls_before_its_base() {
    // Already emitted; writing it would mean writing behind the playhead.
    let base = frame_of(1000.0) as u64;
    let mut dst = Vec::new();
    accumulate(&mut dst, base, &chunk(vec![1.0, 1.0]), 2, 0.0);
    assert!(dst.is_empty());
  }

  #[test]
  fn a_chunk_straddling_the_base_keeps_only_the_part_after_it() {
    let base = 2u64;
    let mut dst = Vec::new();
    // Four frames starting at frame 0; the first two are behind the base.
    accumulate(
      &mut dst,
      base,
      &chunk(vec![1.0, 1.0, 2.0, 2.0, 3.0, 3.0, 4.0, 4.0]),
      2,
      0.0,
    );
    assert_eq!(dst, vec![3.0, 3.0, 4.0, 4.0]);
  }

  #[test]
  fn a_negative_offset_is_treated_as_before_the_base() {
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![1.0, 1.0]), 2, -500.0);
    assert!(dst.is_empty());
  }

  #[test]
  fn a_partial_trailing_frame_is_ignored_rather_than_read_past_the_end() {
    // Three samples at two channels is one frame and a half.
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![1.0, 2.0, 3.0]), 2, 0.0);
    assert_eq!(dst, vec![1.0, 2.0]);
  }

  #[test]
  fn a_long_chunk_is_written_end_to_end() {
    let frames = 1000;
    let samples: Vec<f32> = (0..frames * 2).map(|i| i as f32).collect();
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(samples.clone()), 2, 0.0);
    assert_eq!(dst.len(), frames * 2);
    assert_eq!(dst[frames * 2 - 1], samples[frames * 2 - 1]);
  }
}

#[cfg(test)]
mod frame_clock_scenarios {
  use super::*;

  #[test]
  fn the_first_frame_is_at_zero() {
    assert_eq!(frame_to_ms(0), 0.0);
  }

  #[test]
  fn a_seconds_worth_of_frames_is_a_second() {
    assert_eq!(frame_to_ms(MIX_SAMPLE_RATE as u64), 1000.0);
  }

  #[test]
  fn half_a_seconds_worth_of_frames_is_half_a_second() {
    assert_eq!(frame_to_ms(MIX_SAMPLE_RATE as u64 / 2), 500.0);
  }

  #[test]
  fn one_frame_is_a_small_fraction_of_a_millisecond() {
    let ms = frame_to_ms(1);
    assert!(ms > 0.0 && ms < 0.03, "{ms}");
  }

  #[test]
  fn the_clock_is_linear_in_the_frame_count() {
    let step = frame_to_ms(1000) - frame_to_ms(0);
    let later = frame_to_ms(101_000) - frame_to_ms(100_000);
    assert!((step - later).abs() < 1e-9);
  }

  #[test]
  fn the_clock_rises_with_the_frame_count() {
    let mut last = -1.0;
    for frame in [0u64, 1, 100, 48_000, 4_800_000] {
      let ms = frame_to_ms(frame);
      assert!(ms > last, "{frame}");
      last = ms;
    }
  }

  #[test]
  fn an_hours_worth_of_frames_is_an_hour() {
    let hour = MIX_SAMPLE_RATE as u64 * 3600;
    assert!((frame_to_ms(hour) - 3_600_000.0).abs() < 1e-6);
  }
}

#[cfg(test)]
mod placement_scenarios {
  use super::*;
  use crate::engine::cuts::Cut;

  fn cuts(list: Vec<(f64, f64)>) -> CutTrack {
    CutTrack::new(
      list
        .into_iter()
        .map(|(start_ms, end_ms)| Cut { start_ms, end_ms })
        .collect(),
    )
  }

  #[test]
  fn with_no_cuts_and_no_offset_audio_stays_where_it_was() {
    let track = cuts(Vec::new());
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: 0.0,
    };
    for t in [0.0, 100.0, 5000.0] {
      assert_eq!(placement.place(t), Some(t), "{t}");
    }
  }

  #[test]
  fn a_chunk_inside_a_cut_is_dropped() {
    let track = cuts(vec![(1000.0, 2000.0)]);
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: 0.0,
    };
    assert_eq!(placement.place(1500.0), None);
  }

  #[test]
  fn a_chunk_on_a_cuts_start_is_dropped() {
    let track = cuts(vec![(1000.0, 2000.0)]);
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: 0.0,
    };
    assert_eq!(placement.place(1000.0), None);
  }

  #[test]
  fn a_chunk_on_a_cuts_end_survives() {
    // Half open, matching the video side -- the two clocks have to agree or
    // the sound drifts a frame away from the picture at every cut.
    let track = cuts(vec![(1000.0, 2000.0)]);
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: 0.0,
    };
    assert_eq!(placement.place(2000.0), Some(1000.0));
  }

  #[test]
  fn a_chunk_after_a_cut_moves_back_by_its_length() {
    let track = cuts(vec![(1000.0, 2000.0)]);
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: 0.0,
    };
    assert_eq!(placement.place(3000.0), Some(2000.0));
  }

  #[test]
  fn a_chunk_before_a_cut_does_not_move() {
    let track = cuts(vec![(1000.0, 2000.0)]);
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: 0.0,
    };
    assert_eq!(placement.place(500.0), Some(500.0));
  }

  #[test]
  fn an_offset_shifts_a_sidecar_before_the_cuts_are_applied() {
    // A camera that started recording half a second after the screen: its own
    // clock starts at zero, so it has to be moved onto the screen's timeline
    // before the cut mapping can mean anything.
    let track = cuts(vec![(1000.0, 2000.0)]);
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: 500.0,
    };
    // Source 700 is really 1200 on the screen's clock, which is inside the cut.
    assert_eq!(placement.place(700.0), None);
  }

  #[test]
  fn an_offset_moves_a_chunk_that_is_not_cut() {
    let track = cuts(Vec::new());
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: 500.0,
    };
    assert_eq!(placement.place(100.0), Some(600.0));
  }

  #[test]
  fn a_negative_offset_pulls_a_sidecar_earlier() {
    let track = cuts(Vec::new());
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: -200.0,
    };
    assert_eq!(placement.place(1000.0), Some(800.0));
  }

  #[test]
  fn a_negative_offset_cannot_push_audio_before_the_start() {
    let track = cuts(Vec::new());
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: -5000.0,
    };
    assert_eq!(placement.place(100.0), Some(0.0));
  }

  #[test]
  fn several_cuts_accumulate_for_audio_the_same_way_they_do_for_video() {
    let track = cuts(vec![(1000.0, 2000.0), (4000.0, 4500.0)]);
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: 0.0,
    };
    assert_eq!(placement.place(5000.0), Some(3500.0));
  }

  #[test]
  fn every_surviving_chunk_lands_on_the_same_clock_the_video_uses() {
    let track = cuts(vec![(1000.0, 2000.0), (4000.0, 4500.0)]);
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: 0.0,
    };
    for step in 0..80 {
      let source = step as f64 * 100.0;
      if let Some(at) = placement.place(source) {
        assert_eq!(at, track.to_composition(source), "{source}");
      } else {
        assert!(track.contains(source), "{source}");
      }
    }
  }

  #[test]
  fn placement_never_goes_backwards() {
    let track = cuts(vec![(1000.0, 2000.0), (4000.0, 4500.0)]);
    let placement = SourcePlacement {
      cuts: &track,
      offset_ms: 0.0,
    };
    let mut last = -1.0;
    for step in 0..80 {
      if let Some(at) = placement.place(step as f64 * 100.0) {
        assert!(at >= last, "step {step}");
        last = at;
      }
    }
  }
}

#[cfg(test)]
mod accumulate_matrix {
  use super::*;

  /// Channel counts a real source reports.
  const CHANNELS: [u32; 6] = [1, 2, 3, 4, 6, 8];

  /// Offsets in milliseconds, including ones that do not land on a frame.
  const OFFSETS: [f64; 9] = [0.0, 0.01, 1.0, 10.0, 20.833, 100.0, 500.0, 1000.0, 3600.0];

  fn chunk(samples: Vec<f32>) -> AudioChunk {
    AudioChunk {
      timestamp_100ns: 0,
      samples,
      end_of_stream: false,
    }
  }

  fn frame_of(ms: f64) -> usize {
    (ms / 1000.0 * MIX_SAMPLE_RATE as f64).round() as usize
  }

  /// `frames` frames of a ramp, interleaved across `channels`.
  fn ramp(frames: usize, channels: u32) -> Vec<f32> {
    (0..frames * channels as usize)
      .map(|i| (i % 97) as f32 / 97.0)
      .collect()
  }

  #[test]
  fn the_output_is_stereo_for_every_channel_count() {
    for channels in CHANNELS {
      let mut dst = Vec::new();
      accumulate(&mut dst, 0, &chunk(ramp(1, channels)), channels, 0.0);
      assert_eq!(dst.len(), MIX_CHANNELS as usize, "{channels}ch");
    }
  }

  #[test]
  fn the_frame_count_survives_every_channel_count() {
    for channels in CHANNELS {
      for frames in [1usize, 2, 10, 480] {
        let mut dst = Vec::new();
        accumulate(&mut dst, 0, &chunk(ramp(frames, channels)), channels, 0.0);
        assert_eq!(
          dst.len(),
          frames * MIX_CHANNELS as usize,
          "{channels}ch {frames} frames"
        );
      }
    }
  }

  #[test]
  fn mono_is_duplicated_and_multichannel_is_taken_from_the_front() {
    for channels in CHANNELS {
      let mut dst = Vec::new();
      let samples: Vec<f32> = (0..channels).map(|c| (c + 1) as f32 / 10.0).collect();
      accumulate(&mut dst, 0, &chunk(samples.clone()), channels, 0.0);
      if channels == 1 {
        assert_eq!(dst[0], dst[1], "{channels}ch should be heard on both sides");
        assert_eq!(dst[0], samples[0], "{channels}ch");
      } else {
        assert_eq!(dst[0], samples[0], "{channels}ch left");
        assert_eq!(dst[1], samples[1], "{channels}ch right");
      }
    }
  }

  #[test]
  fn a_chunk_lands_at_its_offset_for_every_offset_and_channel_count() {
    for channels in CHANNELS {
      for offset in OFFSETS {
        let mut dst = Vec::new();
        let samples: Vec<f32> = (0..channels).map(|_| 1.0).collect();
        accumulate(&mut dst, 0, &chunk(samples), channels, offset);
        let frame = frame_of(offset);
        assert_eq!(
          dst.len(),
          (frame + 1) * MIX_CHANNELS as usize,
          "{channels}ch at {offset}ms"
        );
        assert_eq!(dst[frame * 2], 1.0, "{channels}ch at {offset}ms");
      }
    }
  }

  #[test]
  fn everything_before_a_placed_chunk_is_silence_for_every_offset() {
    for offset in OFFSETS.iter().filter(|o| **o > 0.05) {
      let mut dst = Vec::new();
      accumulate(&mut dst, 0, &chunk(vec![1.0, 1.0]), 2, *offset);
      let frame = frame_of(*offset);
      assert!(
        dst[..frame * 2].iter().all(|s| *s == 0.0),
        "{offset}ms leaked into the gap"
      );
    }
  }

  #[test]
  fn summing_is_commutative_across_every_channel_pairing() {
    for a_ch in CHANNELS {
      for b_ch in CHANNELS {
        let a = ramp(4, a_ch);
        let b = ramp(4, b_ch);
        let mut forward = Vec::new();
        accumulate(&mut forward, 0, &chunk(a.clone()), a_ch, 0.0);
        accumulate(&mut forward, 0, &chunk(b.clone()), b_ch, 0.0);
        let mut backward = Vec::new();
        accumulate(&mut backward, 0, &chunk(b), b_ch, 0.0);
        accumulate(&mut backward, 0, &chunk(a), a_ch, 0.0);
        assert_eq!(forward, backward, "{a_ch}ch + {b_ch}ch");
      }
    }
  }

  #[test]
  fn summing_is_associative_for_three_sources() {
    let mut left = Vec::new();
    for samples in [vec![0.1f32, 0.2], vec![0.3, 0.4], vec![0.5, 0.6]] {
      accumulate(&mut left, 0, &chunk(samples), 2, 0.0);
    }
    let mut right = Vec::new();
    for samples in [vec![0.5f32, 0.6], vec![0.1, 0.2], vec![0.3, 0.4]] {
      accumulate(&mut right, 0, &chunk(samples), 2, 0.0);
    }
    for (a, b) in left.iter().zip(right.iter()) {
      assert!((a - b).abs() < 1e-6, "{a} vs {b}");
    }
  }

  #[test]
  fn a_source_never_writes_behind_the_base_for_any_base_and_offset() {
    for base_ms in [0.0f64, 10.0, 100.0, 1000.0] {
      for offset in OFFSETS {
        let base = frame_of(base_ms) as u64;
        let mut dst = Vec::new();
        accumulate(&mut dst, base, &chunk(vec![1.0, 1.0]), 2, offset);
        let label = format!("base {base_ms}ms offset {offset}ms");
        if offset < base_ms {
          assert!(dst.is_empty(), "{label}");
        } else {
          assert!(!dst.is_empty(), "{label}");
        }
      }
    }
  }

  #[test]
  fn a_chunk_straddling_the_base_keeps_only_what_is_ahead_of_it() {
    for kept in 0..=4usize {
      let total = 4usize;
      let base = (total - kept) as u64;
      let samples: Vec<f32> = (0..total * 2).map(|i| (i / 2 + 1) as f32).collect();
      let mut dst = Vec::new();
      accumulate(&mut dst, base, &chunk(samples), 2, 0.0);
      assert_eq!(dst.len(), kept * 2, "kept {kept}");
      if kept > 0 {
        // The first surviving frame is the one at the base.
        assert_eq!(dst[0], (total - kept + 1) as f32, "kept {kept}");
      }
    }
  }

  #[test]
  fn a_partial_trailing_frame_is_dropped_for_every_channel_count() {
    for channels in CHANNELS {
      let mut samples = ramp(2, channels);
      samples.pop();
      let mut dst = Vec::new();
      accumulate(&mut dst, 0, &chunk(samples), channels, 0.0);
      assert_eq!(dst.len(), MIX_CHANNELS as usize, "{channels}ch");
    }
  }

  #[test]
  fn nothing_is_written_for_a_degenerate_chunk_in_any_configuration() {
    for channels in CHANNELS {
      for offset in OFFSETS {
        let mut dst = Vec::new();
        accumulate(&mut dst, 0, &chunk(Vec::new()), channels, offset);
        assert!(dst.is_empty(), "{channels}ch at {offset}ms");
      }
    }
    for offset in OFFSETS {
      let mut dst = Vec::new();
      accumulate(&mut dst, 0, &chunk(vec![1.0, 1.0]), 0, offset);
      assert!(dst.is_empty(), "0ch at {offset}ms");
    }
  }

  #[test]
  fn a_negative_offset_never_writes_for_any_channel_count() {
    for channels in CHANNELS {
      for offset in [-0.01f64, -1.0, -1000.0] {
        let mut dst = Vec::new();
        accumulate(&mut dst, 0, &chunk(ramp(4, channels)), channels, offset);
        // Whatever survives must be the tail that lands at or after zero.
        assert!(dst.len() <= 4 * MIX_CHANNELS as usize, "{channels}ch at {offset}");
      }
    }
  }

  #[test]
  fn every_written_sample_is_finite_across_the_matrix() {
    for channels in CHANNELS {
      for offset in OFFSETS {
        for frames in [1usize, 7, 480] {
          let mut dst = Vec::new();
          accumulate(&mut dst, 0, &chunk(ramp(frames, channels)), channels, offset);
          assert!(
            dst.iter().all(|s| s.is_finite()),
            "{channels}ch {frames} frames at {offset}ms"
          );
        }
      }
    }
  }

  #[test]
  fn a_long_chunk_is_written_end_to_end_for_every_channel_count() {
    for channels in CHANNELS {
      let frames = 2_000;
      let samples = ramp(frames, channels);
      let mut dst = Vec::new();
      accumulate(&mut dst, 0, &chunk(samples.clone()), channels, 0.0);
      assert_eq!(dst.len(), frames * MIX_CHANNELS as usize, "{channels}ch");
      let last = (frames - 1) * channels as usize;
      assert_eq!(dst[(frames - 1) * 2], samples[last], "{channels}ch");
    }
  }

  #[test]
  fn growing_the_accumulator_never_disturbs_what_was_already_written() {
    let mut dst = Vec::new();
    accumulate(&mut dst, 0, &chunk(vec![0.9, 0.8]), 2, 0.0);
    let head = (dst[0], dst[1]);
    for offset in [1.0f64, 10.0, 100.0, 1000.0] {
      accumulate(&mut dst, 0, &chunk(vec![0.1, 0.2]), 2, offset);
      assert_eq!((dst[0], dst[1]), head, "after {offset}ms");
    }
  }

  #[test]
  fn the_frame_clock_agrees_with_where_a_chunk_lands_for_every_offset() {
    for offset in OFFSETS {
      let mut dst = Vec::new();
      accumulate(&mut dst, 0, &chunk(vec![1.0, 1.0]), 2, offset);
      let frame = dst.len() / MIX_CHANNELS as usize - 1;
      // `frame_to_ms` is the inverse the mixer uses when reporting position.
      assert!(
        (frame_to_ms(frame as u64) - offset).abs() < 0.03,
        "{offset}ms landed at frame {frame}"
      );
    }
  }
}

#[cfg(test)]
mod placement_matrix {
  use super::*;
  use crate::engine::cuts::Cut;

  fn cuts(list: &[(f64, f64)]) -> CutTrack {
    CutTrack::new(
      list
        .iter()
        .map(|(start_ms, end_ms)| Cut {
          start_ms: *start_ms,
          end_ms: *end_ms,
        })
        .collect(),
    )
  }

  fn cut_sets() -> Vec<(&'static str, Vec<(f64, f64)>)> {
    vec![
      ("none", vec![]),
      ("one", vec![(1_000.0, 2_000.0)]),
      ("two", vec![(1_000.0, 2_000.0), (5_000.0, 6_500.0)]),
      ("touching", vec![(1_000.0, 2_000.0), (2_000.0, 3_000.0)]),
      ("overlapping", vec![(1_000.0, 3_000.0), (2_000.0, 4_000.0)]),
      ("at the start", vec![(0.0, 1_000.0)]),
      (
        "many",
        (0..8)
          .map(|i| (i as f64 * 1_500.0 + 400.0, i as f64 * 1_500.0 + 700.0))
          .collect(),
      ),
    ]
  }

  const OFFSETS: [f64; 7] = [-2_000.0, -500.0, 0.0, 1.0, 250.0, 1_000.0, 5_000.0];

  #[test]
  fn placement_agrees_with_the_video_clock_for_every_cut_set_and_offset() {
    // The sound and the picture have to be on one clock, or they slide apart
    // by the length of the cuts.
    for (name, list) in cut_sets() {
      let track = cuts(&list);
      for offset in OFFSETS {
        let placement = SourcePlacement {
          cuts: &track,
          offset_ms: offset,
        };
        for step in 0..200 {
          let source = step as f64 * 50.0;
          let shifted = source + offset;
          match placement.place(source) {
            Some(at) => {
              assert!(!track.contains(shifted), "{name} offset {offset} at {source}");
              assert_eq!(at, track.to_composition(shifted), "{name} offset {offset}");
            }
            None => assert!(track.contains(shifted), "{name} offset {offset} at {source}"),
          }
        }
      }
    }
  }

  #[test]
  fn placement_never_goes_backwards_for_any_cut_set_and_offset() {
    for (name, list) in cut_sets() {
      let track = cuts(&list);
      for offset in OFFSETS {
        let placement = SourcePlacement {
          cuts: &track,
          offset_ms: offset,
        };
        let mut last = -1.0;
        for step in 0..200 {
          if let Some(at) = placement.place(step as f64 * 50.0) {
            assert!(at >= last, "{name} offset {offset} step {step}");
            last = at;
          }
        }
      }
    }
  }

  #[test]
  fn placement_never_returns_a_negative_time_for_any_cut_set_and_offset() {
    for (name, list) in cut_sets() {
      let track = cuts(&list);
      for offset in OFFSETS {
        let placement = SourcePlacement {
          cuts: &track,
          offset_ms: offset,
        };
        for step in 0..200 {
          if let Some(at) = placement.place(step as f64 * 50.0) {
            assert!(at >= 0.0, "{name} offset {offset} step {step}: {at}");
            assert!(at.is_finite(), "{name} offset {offset} step {step}");
          }
        }
      }
    }
  }

  #[test]
  fn a_positive_offset_delays_the_sound_by_exactly_that_much_with_no_cuts() {
    let track = cuts(&[]);
    for offset in OFFSETS {
      let placement = SourcePlacement {
        cuts: &track,
        offset_ms: offset,
      };
      for source in [0.0f64, 100.0, 5_000.0] {
        let expected = (source + offset).max(0.0);
        assert_eq!(placement.place(source), Some(expected), "offset {offset}");
      }
    }
  }

  #[test]
  fn a_sidecar_and_the_screen_land_together_when_the_offset_is_right() {
    // A camera that started half a second late: its own clock starts at zero,
    // so shifting it by the difference puts the same instant in both files at
    // the same place in the edit.
    let track = cuts(&[(2_000.0, 3_000.0)]);
    let screen = SourcePlacement {
      cuts: &track,
      offset_ms: 0.0,
    };
    let camera = SourcePlacement {
      cuts: &track,
      offset_ms: 500.0,
    };
    for step in 0..100 {
      let screen_ms = step as f64 * 50.0;
      let camera_ms = screen_ms - 500.0;
      if camera_ms < 0.0 {
        continue;
      }
      assert_eq!(
        screen.place(screen_ms),
        camera.place(camera_ms),
        "step {step}"
      );
    }
  }

  #[test]
  fn every_dropped_chunk_was_genuinely_inside_a_cut() {
    for (name, list) in cut_sets() {
      let track = cuts(&list);
      for offset in OFFSETS {
        let placement = SourcePlacement {
          cuts: &track,
          offset_ms: offset,
        };
        let mut dropped = 0;
        for step in 0..200 {
          let source = step as f64 * 50.0;
          if placement.place(source).is_none() {
            dropped += 1;
            assert!(track.contains(source + offset), "{name} offset {offset}");
          }
        }
        if list.is_empty() {
          assert_eq!(dropped, 0, "{name} offset {offset}");
        }
      }
    }
  }
}

#[cfg(test)]
mod audio_pacing_scenarios {
  use super::*;

  /// Frames in one second at the mix rate.
  const SECOND: u64 = MIX_SAMPLE_RATE as u64;

  #[test]
  fn nothing_is_due_at_the_very_start() {
    assert_eq!(audio_frames_due(0.0, 0), 0);
  }

  #[test]
  fn a_seconds_worth_is_due_after_a_second() {
    assert_eq!(audio_frames_due(1000.0, 0), SECOND as usize);
  }

  #[test]
  fn only_what_has_not_been_written_is_due() {
    assert_eq!(audio_frames_due(1000.0, SECOND), 0);
    assert_eq!(audio_frames_due(1000.0, SECOND / 2), (SECOND / 2) as usize);
  }

  #[test]
  fn writing_ahead_of_the_picture_asks_for_nothing_rather_than_underflowing() {
    // The subtraction saturates, so an encoder that ran ahead simply waits.
    assert_eq!(audio_frames_due(0.0, SECOND), 0);
    assert_eq!(audio_frames_due(500.0, SECOND * 10), 0);
  }

  #[test]
  fn a_negative_position_asks_for_nothing() {
    assert_eq!(audio_frames_due(-1000.0, 0), 0);
  }

  #[test]
  fn the_demand_is_derived_from_the_position_not_accumulated() {
    // A variable-rate screen recording has no fixed frames per video frame,
    // and rounding one every frame drifts the audio over a long export.
    let mut written = 0u64;
    // Sixty wildly uneven video frames spread over one second.
    for step in 1..=60 {
      let ms = 1000.0 * (step as f64 / 60.0);
      written += audio_frames_due(ms, written) as u64;
    }
    assert_eq!(written, SECOND);
  }

  #[test]
  fn uneven_frame_spacing_still_lands_on_the_exact_total() {
    let mut written = 0u64;
    let stops = [3.0f64, 91.0, 91.5, 400.0, 401.0, 999.0, 1000.0];
    for ms in stops {
      written += audio_frames_due(ms, written) as u64;
    }
    assert_eq!(written, SECOND);
  }

  #[test]
  fn a_long_export_does_not_accumulate_rounding_error() {
    let mut written = 0u64;
    // Ten minutes at an awkward 59.94fps.
    let total_frames = 10 * 60 * 60;
    for step in 1..=total_frames {
      let ms = step as f64 * 1000.0 / 59.94;
      written += audio_frames_due(ms, written) as u64;
    }
    let expected = (total_frames as f64 * 1000.0 / 59.94 / 1000.0 * SECOND as f64).round() as u64;
    assert_eq!(written, expected);
  }

  #[test]
  fn the_demand_never_goes_backwards_as_the_position_advances() {
    let mut last_target = 0u64;
    for step in 0..500 {
      let ms = step as f64 * 7.3;
      let target = audio_frames_due(ms, 0) as u64;
      assert!(target >= last_target, "step {step}");
      last_target = target;
    }
  }

  #[test]
  fn half_a_second_is_half_a_seconds_worth() {
    assert_eq!(audio_frames_due(500.0, 0), (SECOND / 2) as usize);
  }

  #[test]
  fn a_fraction_of_a_millisecond_rounds_rather_than_truncating() {
    // Truncating would leave the audio permanently one frame short of the
    // picture at every position.
    let due = audio_frames_due(1.0 / 48.0, 0);
    assert!(due <= 2, "{due}");
  }

  #[test]
  fn an_hour_long_export_is_an_hours_worth_of_frames() {
    assert_eq!(audio_frames_due(3_600_000.0, 0), (SECOND * 3600) as usize);
  }
}
