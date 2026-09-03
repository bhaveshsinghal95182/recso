//! Cuts, and the two clocks they create.
//!
//! Removing a span from the middle of a recording splits time in two. There is
//! **source time** -- where a frame sits in the file, which is what the decoder
//! and the cut regions themselves are expressed in -- and **composition time**,
//! where that frame sits in the edit the user is watching, which is what the
//! playhead, the cursor track and the zoom timeline are expressed in.
//!
//! ```text
//!   source        0 ────────── 500 ══════ 1500 ────────── 2000
//!                                 (cut)
//!   composition   0 ────────── 500 ────────── 1000
//! ```
//!
//! Getting these the wrong way round is the whole difficulty of cuts, and it is
//! not the kind of mistake that shows up as a crash: the picture plays, the
//! pointer is just in the wrong place, and only after a cut.
//!
//! This matches the editor's `cuts.ts` deliberately, down to the half-open
//! interval -- a frame exactly on `end_ms` survives, so two adjacent cuts do not
//! silently eat the frame between them.

/// One removed span, in **source** time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cut {
  pub start_ms: f64,
  pub end_ms: f64,
}

/// The cuts for a project, normalised.
///
/// Normalisation is not cosmetic: the mapping walks the list in order and
/// assumes no overlaps, so two cuts that touch have to become one or the
/// second one's time gets subtracted twice.
#[derive(Default, Clone)]
pub struct CutTrack {
  cuts: Vec<Cut>,
}

impl CutTrack {
  pub fn new(cuts: Vec<Cut>) -> Self {
    let mut sorted: Vec<Cut> = cuts
      .into_iter()
      // Finiteness first, then the clamp. The other order looks equivalent and
      // is not: `f64::NAN.max(0.0)` returns 0.0 rather than NaN, so a garbage
      // start time would quietly become a real cut at the beginning of the
      // recording instead of being thrown away.
      .filter(|cut| cut.start_ms.is_finite() && cut.end_ms.is_finite())
      .map(|cut| Cut {
        start_ms: cut.start_ms.max(0.0),
        end_ms: cut.end_ms.max(0.0),
      })
      .filter(|cut| cut.end_ms > cut.start_ms)
      .collect();
    sorted.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));

    let mut merged: Vec<Cut> = Vec::with_capacity(sorted.len());
    for cut in sorted {
      match merged.last_mut() {
        // Touching counts as overlapping. Two cuts that meet exactly are one
        // cut, and leaving them separate is harmless here but not in the
        // mapping.
        Some(previous) if cut.start_ms <= previous.end_ms => {
          previous.end_ms = previous.end_ms.max(cut.end_ms);
        }
        _ => merged.push(cut),
      }
    }

    Self { cuts: merged }
  }

  pub fn len(&self) -> usize {
    self.cuts.len()
  }

  /// Kept beside `len` because clippy asks for the pair, and because "are
  /// there any cuts" is the question a caller actually has.
  #[allow(dead_code)]
  pub fn is_empty(&self) -> bool {
    self.cuts.is_empty()
  }

  /// Whether a **source** timestamp falls in a removed span.
  ///
  /// Half-open: a frame exactly on `end_ms` is kept, because it is the first
  /// frame of what comes after the cut.
  pub fn contains(&self, source_ms: f64) -> bool {
    self
      .cuts
      .iter()
      .any(|cut| source_ms >= cut.start_ms && source_ms < cut.end_ms)
  }

  /// The end of the cut containing this **source** timestamp, if any.
  ///
  /// The player seeks to it rather than decoding through: a ten-second cut is
  /// three hundred frames decoded only to be thrown away, and the playhead
  /// would visibly stall while it happened.
  pub fn cut_end_at(&self, source_ms: f64) -> Option<f64> {
    self
      .cuts
      .iter()
      .find(|cut| source_ms >= cut.start_ms && source_ms < cut.end_ms)
      .map(|cut| cut.end_ms)
  }

  /// How much removed time sits before a **source** timestamp.
  fn removed_before(&self, source_ms: f64) -> f64 {
    let mut removed = 0.0;
    for cut in &self.cuts {
      if source_ms <= cut.start_ms {
        break;
      }
      removed += source_ms.min(cut.end_ms) - cut.start_ms;
    }
    removed
  }

  /// Source time -> composition time. Where a frame from the file lands in the
  /// edit.
  pub fn to_composition(&self, source_ms: f64) -> f64 {
    let source = source_ms.max(0.0);
    (source - self.removed_before(source)).max(0.0)
  }

  /// Composition time -> source time. Where in the file to look for what the
  /// playhead is pointing at.
  ///
  /// Walks forward adding each cut's length, rather than inverting
  /// `to_composition` directly: a composition timestamp has exactly one source
  /// timestamp, but the reverse is not true -- everything inside a cut maps to
  /// the same composition instant -- so only this direction can be a formula.
  pub fn to_source(&self, composition_ms: f64) -> f64 {
    let mut source = composition_ms.max(0.0);
    for cut in &self.cuts {
      if source < cut.start_ms {
        break;
      }
      source += cut.end_ms - cut.start_ms;
    }
    source
  }

  /// How long the edit runs, given how long the file runs.
  pub fn composition_duration(&self, source_duration_ms: f64) -> f64 {
    self.to_composition(source_duration_ms.max(0.0))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn cut(start_ms: f64, end_ms: f64) -> Cut {
    Cut { start_ms, end_ms }
  }

  /// One cut, 500..1500, out of a 2000ms file.
  fn track() -> CutTrack {
    CutTrack::new(vec![cut(500.0, 1500.0)])
  }

  #[test]
  fn with_no_cuts_the_two_clocks_are_the_same() {
    let track = CutTrack::new(vec![]);
    assert_eq!(track.to_composition(1234.0), 1234.0);
    assert_eq!(track.to_source(1234.0), 1234.0);
    assert!(!track.contains(1234.0));
  }

  #[test]
  fn time_before_a_cut_is_untouched() {
    assert_eq!(track().to_composition(200.0), 200.0);
    assert_eq!(track().to_source(200.0), 200.0);
  }

  #[test]
  fn time_after_a_cut_shifts_back_by_its_length() {
    // Source 1500 is the first frame after the cut, and it is composition 500.
    assert_eq!(track().to_composition(1500.0), 500.0);
    assert_eq!(track().to_composition(2000.0), 1000.0);
  }

  #[test]
  fn composition_time_maps_back_to_the_frame_it_came_from() {
    assert_eq!(track().to_source(500.0), 1500.0);
    assert_eq!(track().to_source(1000.0), 2000.0);
  }

  #[test]
  fn the_round_trip_is_stable_outside_cuts() {
    let track = track();
    for source in [0.0, 100.0, 499.0, 1500.0, 1750.0, 2000.0] {
      assert!(!track.contains(source), "{source} should not be cut");
      let round = track.to_source(track.to_composition(source));
      assert!((round - source).abs() < 1e-9, "{source} -> {round}");
    }
  }

  #[test]
  fn a_cut_is_half_open_at_its_end() {
    // The frame on `end_ms` is the first one that survives, so two adjacent
    // cuts cannot silently eat the frame between them.
    assert!(track().contains(500.0));
    assert!(track().contains(1499.0));
    assert!(!track().contains(1500.0));
  }

  #[test]
  fn overlapping_cuts_merge_rather_than_subtracting_twice() {
    let track = CutTrack::new(vec![cut(500.0, 1500.0), cut(1000.0, 2000.0)]);
    assert_eq!(track.len(), 1);
    // 500..2000 removed: 1500ms, not 1000 + 1000.
    assert_eq!(track.to_composition(3000.0), 1500.0);
  }

  #[test]
  fn touching_cuts_merge_too() {
    let track = CutTrack::new(vec![cut(0.0, 100.0), cut(100.0, 200.0)]);
    assert_eq!(track.len(), 1);
    assert_eq!(track.to_composition(300.0), 100.0);
  }

  #[test]
  fn cuts_are_sorted_on_the_way_in() {
    let out_of_order = CutTrack::new(vec![cut(1500.0, 2000.0), cut(0.0, 500.0)]);
    let in_order = CutTrack::new(vec![cut(0.0, 500.0), cut(1500.0, 2000.0)]);
    assert_eq!(
      out_of_order.to_composition(2500.0),
      in_order.to_composition(2500.0)
    );
  }

  #[test]
  fn empty_and_backwards_cuts_are_dropped() {
    let track = CutTrack::new(vec![cut(100.0, 100.0), cut(500.0, 200.0)]);
    assert!(track.is_empty());
  }

  #[test]
  fn a_non_finite_cut_is_dropped_rather_than_poisoning_the_mapping() {
    let track = CutTrack::new(vec![cut(f64::NAN, 100.0), cut(0.0, f64::INFINITY)]);
    assert!(track.is_empty());
    assert_eq!(track.to_composition(500.0), 500.0);
  }

  #[test]
  fn negative_time_clamps_to_zero() {
    assert_eq!(track().to_composition(-100.0), 0.0);
    assert_eq!(track().to_source(-100.0), 0.0);
  }

  #[test]
  fn duration_loses_exactly_what_was_cut() {
    assert_eq!(track().composition_duration(2000.0), 1000.0);
    assert_eq!(CutTrack::new(vec![]).composition_duration(2000.0), 2000.0);
  }

  #[test]
  fn a_cut_running_past_the_end_only_removes_what_exists() {
    let track = CutTrack::new(vec![cut(1500.0, 9000.0)]);
    assert_eq!(track.composition_duration(2000.0), 1500.0);
  }

  #[test]
  fn a_cut_reports_where_it_ends() {
    assert_eq!(track().cut_end_at(700.0), Some(1500.0));
    assert_eq!(track().cut_end_at(200.0), None);
    // Half-open at the end, like `contains`.
    assert_eq!(track().cut_end_at(1500.0), None);
  }

  #[test]
  fn several_cuts_accumulate() {
    let track = CutTrack::new(vec![cut(100.0, 200.0), cut(400.0, 500.0), cut(700.0, 900.0)]);
    // 400ms removed in total before the end.
    assert_eq!(track.composition_duration(1000.0), 600.0);
    // Between the second and third cuts: 600 source, 200 removed so far.
    assert_eq!(track.to_composition(600.0), 400.0);
    assert_eq!(track.to_source(400.0), 600.0);
  }
}
