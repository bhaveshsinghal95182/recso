//! Regressions in the engine's own modules.
//!
//! Split from the crate-level `regressions` because `pattern` and `cuts` are
//! private to `engine`, and widening them so a test could reach them would be
//! letting the tests dictate the shape of the code.
//!
//! Same rule as its sibling: named after the symptom, carrying the reasoning
//! that made it a bug.

// -- a small test surface aborted the process -------------------------------

mod a_small_test_pattern_took_the_process_down {
  use crate::engine::pattern::{test_pattern_bgra, test_pattern_nv12};

  #[test]
  fn a_bgra_pattern_can_be_asked_for_at_any_size() {
    // `TestPatternSource::new` takes its width and height straight from
    // JavaScript. The word "TEST" is 46 pixels wide at the smallest scale, and
    // centring it did `(w - text_w) / 2` on unsigned integers -- so any surface
    // narrower than that wrapped round and panicked, taking Node with it.
    for size in 0..64u32 {
      let buf = test_pattern_bgra(size, size, 0);
      assert_eq!(buf.len(), size as usize * size as usize * 4, "{size}x{size}");
    }
  }

  #[test]
  fn a_bgra_pattern_can_be_asked_for_at_any_shape() {
    for (w, h) in [(0u32, 0u32), (1, 1000), (1000, 1), (3, 3), (45, 45), (47, 47)] {
      let buf = test_pattern_bgra(w, h, 0);
      assert_eq!(buf.len(), w as usize * h as usize * 4, "{w}x{h}");
    }
  }

  #[test]
  fn an_nv12_pattern_can_be_asked_for_at_any_size() {
    // The moving bar's position is a modulo of the width, which is a divide by
    // zero on an empty surface.
    for size in 0..64u32 {
      let buf = test_pattern_nv12(size, size, 0);
      let s = size as usize;
      assert_eq!(buf.len(), s * s + s * (s / 2), "{size}x{size}");
    }
  }

  #[test]
  fn an_nv12_pattern_can_be_asked_for_at_any_shape_and_frame() {
    for (w, h) in [(0u32, 0u32), (0, 480), (640, 0), (2, 2), (65, 33)] {
      for frame in [0u32, 1, 100_000, u32::MAX] {
        let buf = test_pattern_nv12(w, h, frame);
        assert_eq!(
          buf.len(),
          w as usize * h as usize + w as usize * (h as usize / 2),
          "{w}x{h} frame {frame}"
        );
      }
    }
  }

  #[test]
  fn the_pattern_is_still_recognisably_itself_at_a_normal_size() {
    // The guard must clip rather than blank: the pattern exists so that seeing
    // it proves the shared-texture path works.
    let (w, h) = (256usize, 192usize);
    let buf = test_pattern_bgra(w as u32, h as u32, 0);
    // A thick orange border, and white glyphs somewhere in the middle.
    assert_eq!(&buf[..3], &[0x3c, 0x81, 0xf0]);
    let has_white = (h / 3..h * 2 / 3).any(|y| {
      (0..w).any(|x| {
        let i = (y * w + x) * 4;
        buf[i] == 255 && buf[i + 1] == 255 && buf[i + 2] == 255
      })
    });
    assert!(has_white, "the word went missing");
  }
}

// -- things that were right and must stay right -----------------------------

mod invariants_worth_keeping {
  use crate::engine::cuts::{Cut, CutTrack};

  #[test]
  fn a_cut_is_half_open_so_adjacent_cuts_do_not_eat_the_frame_between_them() {
    // The editor's `cuts.ts` agrees, down to this. If either side ever closed
    // the interval, two adjacent cuts would silently drop a frame -- and the
    // only symptom would be a one-frame jump in a finished export.
    let track = CutTrack::new(vec![
      Cut { start_ms: 0.0, end_ms: 1_000.0 },
      Cut { start_ms: 1_000.0, end_ms: 2_000.0 },
    ]);
    assert!(track.contains(1_000.0), "the seam must be inside the merged cut");
    assert!(!track.contains(2_000.0), "the frame after must survive");
    assert_eq!(track.to_composition(2_000.0), 0.0);
  }

  #[test]
  fn a_garbage_cut_time_is_thrown_away_rather_than_clamped_to_the_start() {
    // Finiteness is checked before the clamp, and the order is not cosmetic:
    // `f64::NAN.max(0.0)` is 0.0, so clamping first would turn a garbage start
    // time into a real cut at the beginning of the recording.
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
      let track = CutTrack::new(vec![Cut {
        start_ms: bad,
        end_ms: 1_000.0,
      }]);
      assert!(track.is_empty(), "{bad} became a real cut");
    }
  }

  #[test]
  fn overlapping_cuts_merge_so_their_overlap_is_not_subtracted_twice() {
    // Without the merge the mapping walks both cuts and removes the shared
    // span from the clock twice, so everything after runs early.
    let track = CutTrack::new(vec![
      Cut { start_ms: 0.0, end_ms: 2_000.0 },
      Cut { start_ms: 1_000.0, end_ms: 3_000.0 },
    ]);
    assert_eq!(track.len(), 1);
    assert_eq!(track.to_composition(4_000.0), 1_000.0);
  }
}
