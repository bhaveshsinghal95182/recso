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
#[derive(Default, Clone, Debug, PartialEq)]
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
  fn two_ways_of_writing_the_same_edit_compare_equal() {
    // The player leans on this to tell a real cut change from the editor
    // re-sending the composition it already has: only a difference in the
    // *edit* is worth throwing the frame queue away for.
    assert_eq!(CutTrack::new(vec![]), CutTrack::default());
    assert_eq!(
      CutTrack::new(vec![cut(500.0, 1500.0), cut(2000.0, 2500.0)]),
      CutTrack::new(vec![cut(2000.0, 2500.0), cut(500.0, 1500.0)]),
    );
    // Merged and unmerged spellings of one removed span.
    assert_eq!(
      CutTrack::new(vec![cut(0.0, 100.0), cut(100.0, 200.0)]),
      CutTrack::new(vec![cut(0.0, 200.0)]),
    );
    // And a genuine difference still reads as one.
    assert_ne!(
      CutTrack::new(vec![cut(0.0, 200.0)]),
      CutTrack::new(vec![cut(0.0, 201.0)]),
    );
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
    let track = CutTrack::new(vec![
      cut(100.0, 200.0),
      cut(400.0, 500.0),
      cut(700.0, 900.0),
    ]);
    // 400ms removed in total before the end.
    assert_eq!(track.composition_duration(1000.0), 600.0);
    // Between the second and third cuts: 600 source, 200 removed so far.
    assert_eq!(track.to_composition(600.0), 400.0);
    assert_eq!(track.to_source(400.0), 600.0);
  }
}

#[cfg(test)]
mod normalisation_scenarios {
  use super::*;

  fn cut(start_ms: f64, end_ms: f64) -> Cut {
    Cut { start_ms, end_ms }
  }

  #[test]
  fn an_empty_list_makes_an_empty_track() {
    let track = CutTrack::new(Vec::new());
    assert_eq!(track.len(), 0);
    assert!(track.is_empty());
  }

  #[test]
  fn the_default_track_has_no_cuts() {
    assert!(CutTrack::default().is_empty());
  }

  #[test]
  fn a_single_cut_survives_intact() {
    let track = CutTrack::new(vec![cut(500.0, 1500.0)]);
    assert_eq!(track.len(), 1);
    assert!(!track.is_empty());
  }

  #[test]
  fn separate_cuts_stay_separate() {
    let track = CutTrack::new(vec![cut(0.0, 1000.0), cut(2000.0, 3000.0)]);
    assert_eq!(track.len(), 2);
  }

  #[test]
  fn cuts_arriving_out_of_order_are_sorted() {
    // The mapping walks the list in order and assumes it is sorted.
    let track = CutTrack::new(vec![
      cut(4000.0, 5000.0),
      cut(0.0, 1000.0),
      cut(2000.0, 3000.0),
    ]);
    assert_eq!(track.len(), 3);
    assert_eq!(track.to_composition(6000.0), 3000.0);
  }

  #[test]
  fn overlapping_cuts_merge_into_one() {
    // Otherwise the overlap gets subtracted twice and the picture runs early.
    let track = CutTrack::new(vec![cut(0.0, 2000.0), cut(1000.0, 3000.0)]);
    assert_eq!(track.len(), 1);
    assert_eq!(track.to_composition(4000.0), 1000.0);
  }

  #[test]
  fn touching_cuts_merge_too() {
    let track = CutTrack::new(vec![cut(0.0, 1000.0), cut(1000.0, 2000.0)]);
    assert_eq!(track.len(), 1);
    assert_eq!(track.to_composition(3000.0), 1000.0);
  }

  #[test]
  fn a_cut_swallowed_by_a_longer_one_does_not_extend_it() {
    let track = CutTrack::new(vec![cut(0.0, 5000.0), cut(1000.0, 2000.0)]);
    assert_eq!(track.len(), 1);
    assert_eq!(track.to_composition(6000.0), 1000.0);
  }

  #[test]
  fn a_chain_of_overlaps_collapses_to_one() {
    let track = CutTrack::new(vec![
      cut(0.0, 1000.0),
      cut(900.0, 2000.0),
      cut(1900.0, 3000.0),
      cut(2900.0, 4000.0),
    ]);
    assert_eq!(track.len(), 1);
    assert_eq!(track.to_composition(5000.0), 1000.0);
  }

  #[test]
  fn merging_takes_the_furthest_end_not_the_last_one_seen() {
    let track = CutTrack::new(vec![cut(0.0, 5000.0), cut(100.0, 200.0)]);
    assert!(track.contains(4000.0));
  }

  #[test]
  fn a_cut_of_no_length_is_dropped() {
    assert!(CutTrack::new(vec![cut(1000.0, 1000.0)]).is_empty());
  }

  #[test]
  fn a_backwards_cut_is_dropped() {
    assert!(CutTrack::new(vec![cut(2000.0, 1000.0)]).is_empty());
  }

  #[test]
  fn dropping_the_empty_ones_leaves_the_real_ones_alone() {
    let track = CutTrack::new(vec![
      cut(0.0, 0.0),
      cut(1000.0, 2000.0),
      cut(5000.0, 4000.0),
    ]);
    assert_eq!(track.len(), 1);
    assert!(track.contains(1500.0));
  }

  #[test]
  fn a_cut_starting_before_the_recording_is_clamped_to_its_beginning() {
    let track = CutTrack::new(vec![cut(-500.0, 1000.0)]);
    assert_eq!(track.len(), 1);
    assert!(track.contains(0.0));
    assert_eq!(track.to_composition(2000.0), 1000.0);
  }

  #[test]
  fn a_cut_entirely_before_the_recording_collapses_and_is_dropped() {
    // Both ends clamp to zero, which makes it zero length.
    assert!(CutTrack::new(vec![cut(-500.0, -100.0)]).is_empty());
  }

  #[test]
  fn a_cut_with_a_non_finite_start_is_thrown_away() {
    // And specifically not clamped to zero: `NAN.max(0.0)` is 0.0, so clamping
    // first would turn garbage into a real cut at the start of the recording.
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
      let track = CutTrack::new(vec![cut(bad, 1000.0)]);
      assert!(track.is_empty(), "{bad}");
    }
  }

  #[test]
  fn a_cut_with_a_non_finite_end_is_thrown_away() {
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
      let track = CutTrack::new(vec![cut(1000.0, bad)]);
      assert!(track.is_empty(), "{bad}");
    }
  }

  #[test]
  fn a_bad_cut_does_not_take_the_good_ones_with_it() {
    let track = CutTrack::new(vec![cut(f64::NAN, 100.0), cut(1000.0, 2000.0)]);
    assert_eq!(track.len(), 1);
    assert_eq!(track.to_composition(3000.0), 2000.0);
  }

  #[test]
  fn normalising_an_already_normal_list_changes_nothing() {
    let clean = vec![cut(1000.0, 2000.0), cut(4000.0, 5000.0)];
    let track = CutTrack::new(clean);
    assert_eq!(track.len(), 2);
    assert_eq!(track.to_composition(6000.0), 4000.0);
  }

  #[test]
  fn many_cuts_all_survive_when_none_of_them_touch() {
    let list: Vec<Cut> = (0..20)
      .map(|i| cut(i as f64 * 1000.0, i as f64 * 1000.0 + 100.0))
      .collect();
    assert_eq!(CutTrack::new(list).len(), 20);
  }
}

#[cfg(test)]
mod mapping_scenarios {
  use super::*;

  fn cut(start_ms: f64, end_ms: f64) -> Cut {
    Cut { start_ms, end_ms }
  }

  /// One cut removing 500..1500 from the source.
  fn single() -> CutTrack {
    CutTrack::new(vec![cut(500.0, 1500.0)])
  }

  /// Two cuts: 500..1500 and 2500..3000.
  fn double() -> CutTrack {
    CutTrack::new(vec![cut(500.0, 1500.0), cut(2500.0, 3000.0)])
  }

  #[test]
  fn with_no_cuts_the_two_clocks_are_the_same() {
    let track = CutTrack::new(Vec::new());
    for t in [0.0, 1.0, 500.0, 12_345.0] {
      assert_eq!(track.to_composition(t), t, "{t}");
      assert_eq!(track.to_source(t), t, "{t}");
    }
  }

  #[test]
  fn time_before_a_cut_is_untouched() {
    for t in [0.0, 100.0, 499.0] {
      assert_eq!(single().to_composition(t), t, "{t}");
    }
  }

  #[test]
  fn the_instant_a_cut_starts_is_still_untouched() {
    assert_eq!(single().to_composition(500.0), 500.0);
  }

  #[test]
  fn time_after_a_cut_shifts_back_by_its_length() {
    assert_eq!(single().to_composition(2000.0), 1000.0);
    assert_eq!(single().to_composition(5000.0), 4000.0);
  }

  #[test]
  fn the_first_frame_after_a_cut_lands_where_the_cut_started() {
    // Half-open, so the frame exactly on `end_ms` is the first one kept.
    assert_eq!(single().to_composition(1500.0), 500.0);
  }

  #[test]
  fn everything_inside_a_cut_collapses_to_its_start() {
    // There is no composition instant for removed time, so it has to land
    // somewhere -- and the start is where the edit continues from.
    for t in [500.0, 900.0, 1400.0, 1499.9] {
      assert_eq!(single().to_composition(t), 500.0, "{t}");
    }
  }

  #[test]
  fn composition_time_maps_back_to_the_frame_it_came_from() {
    assert_eq!(single().to_source(1000.0), 2000.0);
    assert_eq!(single().to_source(4000.0), 5000.0);
  }

  #[test]
  fn composition_time_before_a_cut_maps_straight_through() {
    for t in [0.0, 100.0, 499.0] {
      assert_eq!(single().to_source(t), t, "{t}");
    }
  }

  #[test]
  fn composition_time_at_a_cuts_start_skips_to_its_end() {
    // The playhead is pointing at the first thing after the cut.
    assert_eq!(single().to_source(500.0), 1500.0);
  }

  #[test]
  fn the_round_trip_is_stable_outside_cuts() {
    for t in [0.0, 100.0, 499.0, 1500.0, 2000.0, 9999.0] {
      let back = single().to_composition(single().to_source(single().to_composition(t)));
      assert_eq!(back, single().to_composition(t), "{t}");
    }
  }

  #[test]
  fn composition_to_source_and_back_is_the_identity() {
    // This direction is a real inverse: every composition instant has exactly
    // one source frame behind it.
    for t in [0.0, 100.0, 499.0, 500.0, 1000.0, 2000.0, 9999.0] {
      assert_eq!(double().to_composition(double().to_source(t)), t, "{t}");
    }
  }

  #[test]
  fn several_cuts_accumulate() {
    assert_eq!(double().to_composition(2000.0), 1000.0);
    assert_eq!(double().to_composition(4000.0), 2500.0);
  }

  #[test]
  fn several_cuts_accumulate_in_the_other_direction_too() {
    assert_eq!(double().to_source(1000.0), 2000.0);
    assert_eq!(double().to_source(2500.0), 4000.0);
  }

  #[test]
  fn a_timestamp_between_two_cuts_only_loses_the_first_one() {
    assert_eq!(double().to_composition(2400.0), 1400.0);
  }

  #[test]
  fn a_timestamp_inside_the_second_cut_collapses_to_that_cuts_start() {
    assert_eq!(double().to_composition(2700.0), 1500.0);
  }

  #[test]
  fn negative_source_time_clamps_to_zero() {
    assert_eq!(single().to_composition(-100.0), 0.0);
    assert_eq!(single().to_composition(-1e9), 0.0);
  }

  #[test]
  fn negative_composition_time_clamps_to_zero() {
    let track = CutTrack::new(Vec::new());
    assert_eq!(track.to_composition(-100.0), 0.0);
    assert_eq!(track.to_source(-100.0), 0.0);
  }

  #[test]
  fn a_cut_at_the_very_beginning_shifts_everything_back() {
    let track = CutTrack::new(vec![cut(0.0, 1000.0)]);
    assert_eq!(track.to_composition(1000.0), 0.0);
    assert_eq!(track.to_composition(3000.0), 2000.0);
    assert_eq!(track.to_source(0.0), 1000.0);
  }

  #[test]
  fn a_cut_at_the_very_beginning_leaves_nothing_before_it() {
    let track = CutTrack::new(vec![cut(0.0, 1000.0)]);
    for t in [0.0, 500.0, 999.0] {
      assert_eq!(track.to_composition(t), 0.0, "{t}");
    }
  }

  #[test]
  fn mapping_forward_never_goes_backwards() {
    // Monotonic, which is what makes the playhead usable: scrubbing right in
    // the source can never move the composition playhead left.
    let mut last = -1.0;
    for step in 0..200 {
      let value = double().to_composition(step as f64 * 25.0);
      assert!(value >= last, "step {step}: {value} < {last}");
      last = value;
    }
  }

  #[test]
  fn mapping_backward_never_goes_backwards_either() {
    let mut last = -1.0;
    for step in 0..200 {
      let value = double().to_source(step as f64 * 25.0);
      assert!(value >= last, "step {step}: {value} < {last}");
      last = value;
    }
  }

  #[test]
  fn composition_time_never_runs_ahead_of_source_time() {
    for step in 0..200 {
      let source = step as f64 * 25.0;
      assert!(double().to_composition(source) <= source, "{source}");
    }
  }

  #[test]
  fn source_time_never_runs_behind_composition_time() {
    for step in 0..200 {
      let composition = step as f64 * 25.0;
      assert!(
        double().to_source(composition) >= composition,
        "{composition}"
      );
    }
  }

  #[test]
  fn twenty_cuts_map_consistently_in_both_directions() {
    let list: Vec<Cut> = (0..20)
      .map(|i| cut(i as f64 * 1000.0 + 500.0, i as f64 * 1000.0 + 700.0))
      .collect();
    let track = CutTrack::new(list);
    for step in 0..80 {
      let composition = step as f64 * 100.0;
      assert_eq!(
        track.to_composition(track.to_source(composition)),
        composition,
        "step {step}"
      );
    }
  }
}

#[cfg(test)]
mod containment_scenarios {
  use super::*;

  fn cut(start_ms: f64, end_ms: f64) -> Cut {
    Cut { start_ms, end_ms }
  }

  fn track() -> CutTrack {
    CutTrack::new(vec![cut(500.0, 1500.0), cut(2500.0, 3000.0)])
  }

  #[test]
  fn an_empty_track_contains_nothing() {
    let empty = CutTrack::new(Vec::new());
    for t in [-1.0, 0.0, 1000.0, 1e9] {
      assert!(!empty.contains(t), "{t}");
    }
  }

  #[test]
  fn a_cut_contains_its_own_middle() {
    assert!(track().contains(1000.0));
    assert!(track().contains(2700.0));
  }

  #[test]
  fn a_cut_contains_its_own_start() {
    assert!(track().contains(500.0));
    assert!(track().contains(2500.0));
  }

  #[test]
  fn a_cut_does_not_contain_its_own_end() {
    // Half-open: that frame is the first one of what comes after.
    assert!(!track().contains(1500.0));
    assert!(!track().contains(3000.0));
  }

  #[test]
  fn time_before_the_first_cut_is_not_contained() {
    for t in [0.0, 100.0, 499.9] {
      assert!(!track().contains(t), "{t}");
    }
  }

  #[test]
  fn time_between_cuts_is_not_contained() {
    for t in [1500.0, 2000.0, 2499.9] {
      assert!(!track().contains(t), "{t}");
    }
  }

  #[test]
  fn time_after_the_last_cut_is_not_contained() {
    for t in [3000.0, 5000.0, 1e9] {
      assert!(!track().contains(t), "{t}");
    }
  }

  #[test]
  fn negative_time_is_not_contained() {
    assert!(!track().contains(-1.0));
  }

  #[test]
  fn back_to_back_cuts_leave_no_frame_between_them() {
    // They merge, so what would have been the seam is inside one cut.
    let merged = CutTrack::new(vec![cut(0.0, 1000.0), cut(1000.0, 2000.0)]);
    assert!(merged.contains(1000.0));
    assert!(!merged.contains(2000.0));
  }

  #[test]
  fn a_cut_reports_where_it_ends() {
    assert_eq!(track().cut_end_at(1000.0), Some(1500.0));
    assert_eq!(track().cut_end_at(2700.0), Some(3000.0));
  }

  #[test]
  fn a_cut_reports_its_end_from_its_own_start() {
    assert_eq!(track().cut_end_at(500.0), Some(1500.0));
  }

  #[test]
  fn there_is_no_cut_end_outside_a_cut() {
    for t in [0.0, 1500.0, 2000.0, 3000.0, 9999.0] {
      assert_eq!(track().cut_end_at(t), None, "{t}");
    }
  }

  #[test]
  fn an_empty_track_never_reports_a_cut_end() {
    assert_eq!(CutTrack::new(Vec::new()).cut_end_at(1000.0), None);
  }

  #[test]
  fn the_reported_end_is_where_the_player_should_seek_to() {
    // Seeking past the cut instead of decoding through it: a ten second cut is
    // three hundred frames decoded only to be thrown away.
    let end = track().cut_end_at(600.0).unwrap();
    assert!(!track().contains(end));
    assert_eq!(track().to_composition(end), 500.0);
  }

  #[test]
  fn a_merged_cut_reports_the_far_end() {
    let merged = CutTrack::new(vec![cut(0.0, 1000.0), cut(900.0, 5000.0)]);
    assert_eq!(merged.cut_end_at(500.0), Some(5000.0));
  }

  #[test]
  fn containment_and_the_cut_end_always_agree() {
    let t = track();
    for step in 0..400 {
      let at = step as f64 * 10.0;
      assert_eq!(t.contains(at), t.cut_end_at(at).is_some(), "{at}");
    }
  }
}

#[cfg(test)]
mod duration_scenarios {
  use super::*;

  fn cut(start_ms: f64, end_ms: f64) -> Cut {
    Cut { start_ms, end_ms }
  }

  #[test]
  fn with_no_cuts_the_edit_is_as_long_as_the_file() {
    let track = CutTrack::new(Vec::new());
    assert_eq!(track.composition_duration(10_000.0), 10_000.0);
  }

  #[test]
  fn the_edit_loses_exactly_what_was_cut() {
    let track = CutTrack::new(vec![cut(500.0, 1500.0)]);
    assert_eq!(track.composition_duration(10_000.0), 9_000.0);
  }

  #[test]
  fn several_cuts_all_come_off_the_duration() {
    let track = CutTrack::new(vec![cut(500.0, 1500.0), cut(2500.0, 3000.0)]);
    assert_eq!(track.composition_duration(10_000.0), 8_500.0);
  }

  #[test]
  fn merged_cuts_are_only_counted_once() {
    let track = CutTrack::new(vec![cut(0.0, 2000.0), cut(1000.0, 3000.0)]);
    assert_eq!(track.composition_duration(10_000.0), 7_000.0);
  }

  #[test]
  fn a_cut_running_past_the_end_only_removes_what_exists() {
    let track = CutTrack::new(vec![cut(1000.0, 999_999.0)]);
    assert_eq!(track.composition_duration(2000.0), 1000.0);
  }

  #[test]
  fn a_cut_starting_past_the_end_removes_nothing() {
    let track = CutTrack::new(vec![cut(50_000.0, 60_000.0)]);
    assert_eq!(track.composition_duration(2000.0), 2000.0);
  }

  #[test]
  fn cutting_everything_leaves_nothing() {
    let track = CutTrack::new(vec![cut(0.0, 10_000.0)]);
    assert_eq!(track.composition_duration(10_000.0), 0.0);
  }

  #[test]
  fn a_negative_duration_clamps_to_nothing() {
    let track = CutTrack::new(vec![cut(500.0, 1500.0)]);
    assert_eq!(track.composition_duration(-5000.0), 0.0);
  }

  #[test]
  fn a_zero_length_file_has_a_zero_length_edit() {
    let track = CutTrack::new(vec![cut(500.0, 1500.0)]);
    assert_eq!(track.composition_duration(0.0), 0.0);
  }

  #[test]
  fn the_duration_is_never_negative_however_much_is_cut() {
    let track = CutTrack::new(vec![cut(0.0, 1e9)]);
    for duration in [0.0, 1.0, 5000.0, 1e6] {
      assert!(track.composition_duration(duration) >= 0.0, "{duration}");
    }
  }

  #[test]
  fn the_duration_agrees_with_mapping_the_last_frame() {
    let track = CutTrack::new(vec![cut(500.0, 1500.0), cut(2500.0, 3000.0)]);
    assert_eq!(
      track.composition_duration(10_000.0),
      track.to_composition(10_000.0)
    );
  }

  #[test]
  fn the_end_of_the_edit_maps_back_to_the_end_of_the_file() {
    let track = CutTrack::new(vec![cut(500.0, 1500.0), cut(2500.0, 3000.0)]);
    let edit_end = track.composition_duration(10_000.0);
    assert_eq!(track.to_source(edit_end), 10_000.0);
  }
}
