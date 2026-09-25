//! Combination matrices for the frame clock.
//!
//! `singular_clock`'s own tests pin one case per branch. These sweep the
//! cross-product, because the interesting failures in a pacing policy are not
//! "this branch is wrong" but "these two branches disagree about the boundary
//! between them" -- a drift that is both past the resync threshold and inside
//! the late threshold, a queue that is full while the stream is early, a
//! threshold pair the caller passed in the wrong order.

use crate::singular_clock::*;

// -- sweeps ------------------------------------------------------------------

/// Frame rates the capture stack is actually configured with, plus the edges.
const RATES: [u32; 10] = [0, 1, 24, 25, 30, 50, 60, 120, 240, 1000];

/// Drift magnitudes either side of every threshold in the policy.
const DRIFTS: [i64; 13] = [
  0,
  1,
  99_999,
  100_000,
  100_001,
  500_000,
  999_999,
  1_000_000,
  1_000_001,
  5_000_000,
  i64::MAX / 4,
  i64::MAX,
  i64::MIN,
];

const QUEUE_LENS: [usize; 8] = [0, 1, 8, 12, 13, 14, 15, 16];
const CAPACITY: usize = 16;

const LATE: i64 = 100_000;
const RESYNC: i64 = 1_000_000;

// -- periods -----------------------------------------------------------------

mod period_matrix {
  use super::*;

  #[test]
  fn every_rate_yields_a_usable_period() {
    for fps in RATES {
      let period = fps_to_period_100ns(fps);
      assert!(period > 0, "{fps}");
      // A whole second is the longest period any supported rate produces.
      assert!(period <= 10_000_000, "{fps}: {period}");
    }
  }

  #[test]
  fn every_rate_advances_a_tick_forward() {
    for fps in RATES {
      let period = fps_to_period_100ns(fps);
      for from in [0i64, 1, 166_667, 1_000_000_000] {
        assert!(next_tick_100ns(from, period) > from, "{fps} from {from}");
      }
    }
  }

  #[test]
  fn a_tick_quantized_at_any_rate_lands_on_that_rates_grid() {
    for fps in RATES {
      let period = fps_to_period_100ns(fps);
      for raw in [0i64, 1, 12_345, 166_666, 5_000_000, -12_345] {
        let snapped = quantize_tick_100ns(raw, period);
        assert_eq!(snapped % period, 0, "{fps} raw {raw} -> {snapped}");
      }
    }
  }

  #[test]
  fn quantizing_never_moves_a_tick_more_than_half_a_period_at_any_rate() {
    for fps in RATES {
      let period = fps_to_period_100ns(fps);
      for raw in [0i64, 1, 12_345, 166_666, 5_000_000, 99_999_999] {
        let moved = (quantize_tick_100ns(raw, period) - raw).abs();
        assert!(moved <= period / 2 + 1, "{fps} raw {raw}: moved {moved}");
      }
    }
  }

  #[test]
  fn quantizing_is_idempotent_at_every_rate() {
    for fps in RATES {
      let period = fps_to_period_100ns(fps);
      for raw in [-9_999i64, 0, 1, 12_345, 5_000_000] {
        let once = quantize_tick_100ns(raw, period);
        assert_eq!(quantize_tick_100ns(once, period), once, "{fps} raw {raw}");
      }
    }
  }

  #[test]
  fn quantizing_is_monotonic_at_every_rate() {
    for fps in RATES {
      let period = fps_to_period_100ns(fps);
      let mut last = i64::MIN;
      for step in 0..120 {
        let value = quantize_tick_100ns(step * period / 3, period);
        assert!(value >= last, "{fps} step {step}");
        last = value;
      }
    }
  }

  #[test]
  fn a_run_of_ticks_at_any_rate_is_monotonic() {
    for fps in RATES {
      let period = fps_to_period_100ns(fps);
      let ticks: Vec<i64> = (0..240)
        .scan(0i64, |t, _| {
          *t = next_tick_100ns(*t, period);
          Some(*t)
        })
        .collect();
      assert!(is_monotonic_tick_sequence(&ticks), "{fps}");
    }
  }

  #[test]
  fn a_run_of_ticks_at_any_rate_covers_the_expected_span() {
    for fps in [24u32, 25, 30, 50, 60, 120, 240] {
      let period = fps_to_period_100ns(fps);
      let mut tick = 0;
      for _ in 0..fps {
        tick = next_tick_100ns(tick, period);
      }
      // One second's worth of frames, to within the rounding of one period.
      let drift = (tick - 10_000_000).abs();
      assert!(drift <= period, "{fps}: {tick} off by {drift}");
    }
  }

  #[test]
  fn the_effective_webcam_tick_agrees_with_quantizing_at_every_rate() {
    for fps in RATES {
      let period = fps_to_period_100ns(fps);
      for raw in [0i64, 12_345, 166_666, 5_000_000, -1] {
        assert_eq!(
          compute_effective_webcam_tick(raw, period),
          quantize_tick_100ns(raw, period),
          "{fps} raw {raw}"
        );
      }
    }
  }

  #[test]
  fn a_camera_jittering_inside_half_a_period_still_lands_on_the_frame() {
    for fps in [24u32, 30, 60, 120] {
      let period = fps_to_period_100ns(fps);
      let frame = period * 7;
      for jitter in [-(period / 2) + 1, -1, 0, 1, period / 2 - 1] {
        assert_eq!(
          compute_effective_webcam_tick(frame + jitter, period),
          frame,
          "{fps} jitter {jitter}"
        );
      }
    }
  }

  #[test]
  fn drift_between_any_two_ticks_is_finite_and_signed_correctly() {
    for a in DRIFTS {
      for b in DRIFTS {
        let d = drift_100ns(a, b);
        if a > b {
          assert!(d > 0 || d == i64::MAX, "{a} vs {b}: {d}");
        } else if a < b {
          assert!(d < 0 || d == i64::MIN, "{a} vs {b}: {d}");
        } else {
          assert_eq!(d, 0, "{a} vs {b}");
        }
      }
    }
  }

  #[test]
  fn the_delta_is_always_positive_for_every_pair_and_fallback() {
    for previous in [None, Some(i64::MIN), Some(-1_000), Some(0), Some(1_000), Some(i64::MAX)] {
      for current in [i64::MIN, -1_000, 0, 1_000, i64::MAX] {
        for fallback in [i64::MIN, -1, 0, 1, 166_667] {
          let delta = delta_100ns_or_default(previous, current, fallback);
          assert!(delta > 0, "{previous:?} {current} {fallback}: {delta}");
        }
      }
    }
  }

  #[test]
  fn the_delta_is_the_real_gap_whenever_the_clock_moved_forward() {
    for previous in [-1_000i64, 0, 1_000, 1_000_000] {
      for step in [1i64, 100, 166_667, 10_000_000] {
        let current = previous + step;
        assert_eq!(
          delta_100ns_or_default(Some(previous), current, 999),
          step,
          "{previous} + {step}"
        );
      }
    }
  }
}

// -- the pacing decision -----------------------------------------------------

mod frame_action_matrix {
  use super::*;

  fn action(drift: i64, len: usize) -> FrameAction {
    select_frame_action(drift, len, CAPACITY, LATE, RESYNC)
  }

  #[test]
  fn every_cell_of_the_decision_table_yields_a_decision() {
    for drift in DRIFTS {
      for len in QUEUE_LENS {
        let chosen = action(drift, len);
        assert!(
          matches!(
            chosen,
            FrameAction::UseCurrent
              | FrameAction::UseLastWebcam
              | FrameAction::DropWebcam
              | FrameAction::ResyncWebcam
          ),
          "drift {drift} len {len}"
        );
      }
    }
  }

  #[test]
  fn a_drift_past_the_resync_threshold_always_resyncs_whatever_the_queue_is() {
    for drift in DRIFTS.iter().filter(|d| d.saturating_abs() >= RESYNC) {
      for len in QUEUE_LENS {
        assert_eq!(
          action(*drift, len),
          FrameAction::ResyncWebcam,
          "drift {drift} len {len}"
        );
      }
    }
  }

  #[test]
  fn a_drift_inside_the_late_threshold_always_uses_the_current_frame() {
    for drift in DRIFTS.iter().filter(|d| d.saturating_abs() <= LATE) {
      for len in QUEUE_LENS {
        assert_eq!(
          action(*drift, len),
          FrameAction::UseCurrent,
          "drift {drift} len {len}"
        );
      }
    }
  }

  #[test]
  fn the_decision_only_depends_on_the_magnitude_of_a_resyncing_drift() {
    for drift in [RESYNC, RESYNC * 2, 5_000_000, i64::MAX / 4] {
      for len in QUEUE_LENS {
        assert_eq!(action(drift, len), action(-drift, len), "drift {drift} len {len}");
      }
    }
  }

  #[test]
  fn a_late_frame_never_uses_the_current_camera_frame() {
    // Between the two thresholds and late: the camera frame is stale, so it is
    // either held or skipped, never shown as if it were current.
    for drift in DRIFTS
      .iter()
      .filter(|d| **d > LATE && **d < RESYNC)
    {
      for len in QUEUE_LENS {
        let chosen = action(*drift, len);
        assert!(
          matches!(chosen, FrameAction::UseLastWebcam | FrameAction::DropWebcam),
          "drift {drift} len {len}: {chosen:?}"
        );
      }
    }
  }

  #[test]
  fn an_early_frame_never_holds_the_last_camera_frame() {
    // Early is the benign direction -- the frame exists, it is just ahead -- so
    // there is nothing to hold, only to use or to skip under pressure.
    for drift in DRIFTS
      .iter()
      .filter(|d| **d < -LATE && **d > -RESYNC)
    {
      for len in QUEUE_LENS {
        let chosen = action(*drift, len);
        assert!(
          matches!(chosen, FrameAction::UseCurrent | FrameAction::DropWebcam),
          "drift {drift} len {len}: {chosen:?}"
        );
      }
    }
  }

  #[test]
  fn pressure_only_ever_makes_the_decision_more_aggressive() {
    // For a fixed drift, growing the queue can turn a hold into a drop but must
    // never turn a drop back into a hold.
    let rank = |a: FrameAction| match a {
      FrameAction::UseCurrent => 0,
      FrameAction::UseLastWebcam => 1,
      FrameAction::DropWebcam => 2,
      FrameAction::ResyncWebcam => 3,
    };
    for drift in DRIFTS {
      let mut last = -1;
      for len in QUEUE_LENS {
        let now = rank(action(drift, len));
        if rank(action(drift, 0)) == 3 {
          // A resync does not depend on pressure at all.
          assert_eq!(now, 3, "drift {drift} len {len}");
          continue;
        }
        assert!(now >= last, "drift {drift} len {len}: {now} < {last}");
        last = now;
      }
    }
  }

  #[test]
  fn the_late_drop_threshold_is_crossed_exactly_once_across_the_queue() {
    let drift = LATE + 1;
    let mut crossings = 0;
    let mut previous = action(drift, 0);
    for len in 1..=CAPACITY {
      let now = action(drift, len);
      if now != previous {
        crossings += 1;
        previous = now;
      }
    }
    assert_eq!(crossings, 1, "the late branch should switch once");
  }

  #[test]
  fn the_early_drop_threshold_is_crossed_exactly_once_across_the_queue() {
    let drift = -(LATE + 1);
    let mut crossings = 0;
    let mut previous = action(drift, 0);
    for len in 1..=CAPACITY {
      let now = action(drift, len);
      if now != previous {
        crossings += 1;
        previous = now;
      }
    }
    assert_eq!(crossings, 1, "the early branch should switch once");
  }

  #[test]
  fn early_frames_tolerate_at_least_as_much_pressure_as_late_ones() {
    for len in QUEUE_LENS {
      let late = action(LATE + 1, len);
      let early = action(-(LATE + 1), len);
      if late == FrameAction::DropWebcam {
        // Not required to drop, but must never be *more* aggressive.
        assert!(
          early == FrameAction::DropWebcam || early == FrameAction::UseCurrent,
          "len {len}: {early:?}"
        );
      }
    }
  }

  #[test]
  fn a_queue_with_no_capacity_never_forces_a_drop_at_any_drift() {
    for drift in DRIFTS.iter().filter(|d| d.saturating_abs() < RESYNC) {
      for len in [0usize, 1, 100, usize::MAX] {
        assert_ne!(
          select_frame_action(*drift, len, 0, LATE, RESYNC),
          FrameAction::DropWebcam,
          "drift {drift} len {len}"
        );
      }
    }
  }

  #[test]
  fn a_degenerate_threshold_pair_still_produces_a_usable_policy() {
    // The caller can pass these in the wrong order or as zero; the policy
    // repairs them rather than swallowing every frame into one branch.
    for late in [i64::MIN, -1, 0, 1, 100_000] {
      for resync in [i64::MIN, -1, 0, 1, 50_000, 100_000] {
        for drift in DRIFTS {
          for len in [0usize, CAPACITY] {
            let chosen = select_frame_action(drift, len, CAPACITY, late, resync);
            assert!(
              matches!(
                chosen,
                FrameAction::UseCurrent
                  | FrameAction::UseLastWebcam
                  | FrameAction::DropWebcam
                  | FrameAction::ResyncWebcam
              ),
              "late {late} resync {resync} drift {drift} len {len}"
            );
          }
        }
      }
    }
  }

  #[test]
  fn an_on_time_frame_is_used_whatever_the_thresholds_are() {
    for late in [i64::MIN, 0, 1, 100_000] {
      for resync in [i64::MIN, 0, 1, 1_000_000] {
        for len in QUEUE_LENS {
          assert_eq!(
            select_frame_action(0, len, CAPACITY, late, resync),
            FrameAction::UseCurrent,
            "late {late} resync {resync} len {len}"
          );
        }
      }
    }
  }

  #[test]
  fn a_resync_threshold_below_the_late_one_is_pushed_above_it() {
    // Otherwise the resync branch swallows the whole late range and the camera
    // re-anchors on every jitter.
    for late in [1i64, 1_000, 100_000] {
      // Exactly at the late threshold is still "on time".
      assert_eq!(
        select_frame_action(late, 0, CAPACITY, late, 0),
        FrameAction::UseCurrent,
        "late {late}"
      );
      // One past it is the smallest thing that can resync.
      assert_eq!(
        select_frame_action(late + 1, 0, CAPACITY, late, 0),
        FrameAction::ResyncWebcam,
        "late {late}"
      );
    }
  }

  #[test]
  fn extreme_drifts_do_not_overflow_the_magnitude_check() {
    // `saturating_abs`, because i64::MIN has no positive counterpart.
    for drift in [i64::MIN, i64::MIN + 1, i64::MAX, i64::MAX - 1] {
      for len in QUEUE_LENS {
        assert_eq!(action(drift, len), FrameAction::ResyncWebcam, "{drift} {len}");
      }
    }
  }

  #[test]
  fn the_miss_streak_policy_is_a_plain_threshold_across_the_matrix() {
    for threshold in [0u32, 1, 3, 5, 100] {
      for misses in [0u32, 1, 2, 3, 4, 5, 99, u32::MAX] {
        let expected = threshold > 0 && misses >= threshold;
        assert_eq!(
          should_resync_after_misses(misses, threshold),
          expected,
          "misses {misses} threshold {threshold}"
        );
      }
    }
  }

  #[test]
  fn a_zero_miss_threshold_never_resyncs_however_many_are_missed() {
    for misses in [0u32, 1, 100, u32::MAX] {
      assert!(!should_resync_after_misses(misses, 0), "{misses}");
    }
  }

  #[test]
  fn queue_pressure_is_bounded_for_every_pair() {
    for len in [0usize, 1, 8, 16, 100, usize::MAX] {
      for capacity in [0usize, 1, 8, 16, usize::MAX] {
        let value = queue_pressure_ratio(len, capacity);
        assert!((0.0..=1.0).contains(&value), "{len}/{capacity}: {value}");
        assert!(value.is_finite(), "{len}/{capacity}");
      }
    }
  }

  #[test]
  fn queue_pressure_rises_with_the_queue_at_every_capacity() {
    for capacity in [1usize, 4, 16, 64] {
      let mut last = -1.0;
      for len in 0..=capacity * 2 {
        let value = queue_pressure_ratio(len, capacity);
        assert!(value >= last, "capacity {capacity} len {len}");
        last = value;
      }
    }
  }
}

// -- webcam pairing ----------------------------------------------------------

mod pairing_matrix {
  use super::*;

  #[test]
  fn a_match_is_always_within_the_limit_for_every_sweep() {
    let ticks: Vec<i64> = (0..40).map(|i| i * 1_000 - 5_000).collect();
    for limit in [0i64, 1, 499, 500, 501, 5_000, i64::MAX] {
      for target in [-9_000i64, -1, 0, 1, 500, 12_345, 40_000] {
        if let Some(index) = select_closest_webcam_tick(target, &ticks, limit) {
          let drift = (ticks[index] - target).abs();
          assert!(drift <= limit.max(0), "target {target} limit {limit}: {drift}");
        }
      }
    }
  }

  #[test]
  fn a_match_is_always_the_closest_available_for_every_sweep() {
    let ticks: Vec<i64> = (0..40).map(|i| i * 1_000 - 5_000).collect();
    for limit in [0i64, 499, 500, 5_000, i64::MAX] {
      for target in [-9_000i64, -1, 0, 1, 500, 12_345, 40_000] {
        let Some(index) = select_closest_webcam_tick(target, &ticks, limit) else {
          // Nothing matched, so nothing may have been within the limit.
          for tick in &ticks {
            assert!(
              (tick - target).abs() > limit.max(0),
              "target {target} limit {limit} missed {tick}"
            );
          }
          continue;
        };
        let best = (ticks[index] - target).abs();
        for tick in &ticks {
          let drift = (tick - target).abs();
          if drift <= limit.max(0) {
            assert!(best <= drift, "target {target} limit {limit}");
          }
        }
      }
    }
  }

  #[test]
  fn a_tie_always_breaks_to_the_earlier_tick_for_every_sweep() {
    for spread in [1i64, 10, 500, 5_000] {
      let ticks = [1_000 + spread, 1_000 - spread];
      let index = select_closest_webcam_tick(1_000, &ticks, spread).unwrap();
      assert_eq!(ticks[index], 1_000 - spread, "spread {spread}");
    }
  }

  #[test]
  fn an_empty_sweep_never_matches_at_any_limit() {
    for limit in [i64::MIN, 0, 500, i64::MAX] {
      assert_eq!(select_closest_webcam_tick(1_000, &[], limit), None, "{limit}");
    }
  }

  #[test]
  fn a_zero_limit_only_ever_matches_exactly() {
    let ticks: Vec<i64> = (0..20).map(|i| i * 1_000).collect();
    for target in [0i64, 1, 999, 1_000, 19_000, 19_001] {
      match select_closest_webcam_tick(target, &ticks, 0) {
        Some(index) => assert_eq!(ticks[index], target, "{target}"),
        None => assert!(!ticks.contains(&target), "{target}"),
      }
    }
  }

  #[test]
  fn extreme_ticks_never_overflow_the_magnitude_check() {
    let ticks = [i64::MIN, i64::MIN + 1, 0, i64::MAX - 1, i64::MAX];
    for target in [i64::MIN, -1, 0, 1, i64::MAX] {
      for limit in [0i64, 1, i64::MAX] {
        let _ = select_closest_webcam_tick(target, &ticks, limit);
      }
    }
  }

  #[test]
  fn monotonicity_is_decided_by_a_single_regression_anywhere_in_the_run() {
    let base: Vec<i64> = (0..20).collect();
    assert!(is_monotonic_tick_sequence(&base));
    for at in 1..base.len() {
      let mut broken = base.clone();
      broken[at] = broken[at - 1] - 1;
      assert!(!is_monotonic_tick_sequence(&broken), "regression at {at}");
    }
  }

  #[test]
  fn a_run_of_repeats_anywhere_is_still_monotonic() {
    let base: Vec<i64> = (0..20).collect();
    for at in 1..base.len() {
      let mut repeated = base.clone();
      repeated[at] = repeated[at - 1];
      assert!(is_monotonic_tick_sequence(&repeated), "repeat at {at}");
    }
  }
}

// -- audio budget ------------------------------------------------------------

mod audio_budget_matrix {
  use super::*;

  /// (bytes per second, block align) pairs for real capture formats.
  const FORMATS: [(usize, usize); 6] = [
    (192_000, 4),  // 48kHz stereo 16-bit
    (176_400, 4),  // 44.1kHz stereo 16-bit
    (384_000, 8),  // 48kHz stereo 32-bit float
    (96_000, 2),   // 48kHz mono 16-bit
    (8_000, 1),    // 8kHz mono 8-bit
    (1_152_000, 12), // 48kHz 6-channel 32-bit
  ];

  #[test]
  fn the_budget_is_block_aligned_for_every_format_and_frame_rate() {
    for (bps, align) in FORMATS {
      for fps in [24u32, 25, 30, 50, 60, 120, 240] {
        let delta = fps_to_period_100ns(fps);
        let (bytes, _) = expected_audio_bytes(delta, bps, align, 0.0);
        assert_eq!(bytes % align, 0, "{bps}/{align} at {fps}fps: {bytes}");
      }
    }
  }

  #[test]
  fn the_budget_is_never_empty_for_every_format_and_frame_rate() {
    // Handing the encoder nothing stalls the audio stream rather than
    // producing a shorter one.
    for (bps, align) in FORMATS {
      for fps in [24u32, 30, 60, 240] {
        let delta = fps_to_period_100ns(fps);
        let (bytes, _) = expected_audio_bytes(delta, bps, align, 0.0);
        assert!(bytes >= align, "{bps}/{align} at {fps}fps: {bytes}");
      }
    }
  }

  /// What `frames` frames of `period` are worth, in bytes.
  ///
  /// Measured against the clock rather than against a nominal wall second: the
  /// period is rounded to whole 100ns ticks, so 7200 frames at 120fps is a
  /// shade under a minute and the audio is *supposed* to follow the clock.
  fn owed(frames: u64, period_100ns: i64, bytes_per_second: usize) -> i64 {
    let elapsed = frames as f64 * period_100ns as f64 / 10_000_000.0;
    (elapsed * bytes_per_second as f64).round() as i64
  }

  /// Run the budget for `frames` frames and report what it handed over.
  fn run(frames: u64, period_100ns: i64, bytes_per_second: usize, align: usize) -> i64 {
    let mut carry = 0.0;
    let mut total = 0usize;
    for _ in 0..frames {
      let (bytes, next) = expected_audio_bytes(period_100ns, bytes_per_second, align, carry);
      total += bytes;
      carry = next;
    }
    total as i64
  }

  #[test]
  fn a_second_of_frames_is_a_second_of_audio_for_every_format_and_rate() {
    // The carry is what makes this true when the rate does not divide evenly.
    for (bps, align) in FORMATS {
      for fps in [24u32, 25, 30, 50, 60, 120] {
        let period = fps_to_period_100ns(fps);
        let total = run(fps as u64, period, bps, align);
        let drift = (total - owed(fps as u64, period, bps)).abs();
        assert!(
          drift <= (align * 2) as i64,
          "{bps}/{align} at {fps}fps: drift {drift} bytes"
        );
      }
    }
  }

  #[test]
  fn ten_seconds_does_not_accumulate_more_drift_than_one() {
    // The carry is the whole point: without it the error compounds with every
    // frame instead of staying inside one block forever.
    for (bps, align) in FORMATS {
      for fps in [24u32, 30, 60, 120] {
        let period = fps_to_period_100ns(fps);
        let frames = (fps * 10) as u64;
        let one_second = (run(fps as u64, period, bps, align)
          - owed(fps as u64, period, bps))
        .abs();
        let ten_seconds = (run(frames, period, bps, align) - owed(frames, period, bps)).abs();
        assert!(
          ten_seconds <= one_second.max(align as i64 * 2),
          "{bps}/{align} at {fps}fps: 1s drift {one_second}, 10s drift {ten_seconds}"
        );
      }
    }
  }

  #[test]
  fn the_carry_stays_bounded_by_one_block_for_every_format_and_rate() {
    // The carry is "bytes owed": the sub-byte remainder plus whatever block
    // alignment could not hand over. So it is bounded by the block size, and
    // crucially it does not grow without limit -- that would mean the budget
    // was falling permanently behind.
    for (bps, align) in FORMATS {
      for fps in [24u32, 30, 60, 240] {
        let delta = fps_to_period_100ns(fps);
        let mut carry = 0.0;
        for step in 0..200 {
          let (_, next) = expected_audio_bytes(delta, bps, align, carry);
          assert!(
            (0.0..(align as f64 + 1.0)).contains(&next),
            "{bps}/{align} at {fps}fps step {step}: {next}"
          );
          carry = next;
        }
      }
    }
  }

  #[test]
  fn no_format_and_rate_pair_loses_audio_over_a_minute() {
    // The regression this whole matrix exists to catch: a budget that is block
    // aligned but does not carry the alignment remainder drifts steadily, and
    // steady drift is heard rather than seen. A minute of 44.1kHz at 24fps used
    // to lose about 2900 bytes here.
    for (bps, align) in FORMATS {
      for fps in [24u32, 25, 30, 50, 60, 120] {
        let period = fps_to_period_100ns(fps);
        let frames = (fps * 60) as u64;
        let drift = (run(frames, period, bps, align) - owed(frames, period, bps)).abs();
        assert!(
          drift <= (align * 2) as i64,
          "{bps}/{align} at {fps}fps over 60s: drift {drift} bytes"
        );
      }
    }
  }

  #[test]
  fn the_drift_does_not_grow_with_the_length_of_the_recording() {
    // Bounded rather than merely small: a per-frame loss shows up as a drift
    // that is ten times worse over ten times the frames.
    for (bps, align) in FORMATS {
      for fps in [24u32, 30, 60] {
        let period = fps_to_period_100ns(fps);
        let short = (run((fps * 5) as u64, period, bps, align)
          - owed((fps * 5) as u64, period, bps))
        .abs();
        let long = (run((fps * 300) as u64, period, bps, align)
          - owed((fps * 300) as u64, period, bps))
        .abs();
        assert!(
          long <= short.max(align as i64 * 2),
          "{bps}/{align} at {fps}fps: 5s drift {short}, 300s drift {long}"
        );
      }
    }
  }

  #[test]
  fn the_budget_grows_with_time_for_every_format() {
    for (bps, align) in FORMATS {
      let mut last = 0usize;
      for step in 1..60 {
        let (bytes, _) = expected_audio_bytes(step * 200_000, bps, align, 0.0);
        assert!(bytes >= last, "{bps}/{align} step {step}: {bytes} < {last}");
        last = bytes;
      }
    }
  }

  #[test]
  fn a_degenerate_delta_still_yields_one_block_for_every_format() {
    for (bps, align) in FORMATS {
      for delta in [i64::MIN, -1_000, 0, 1] {
        let (bytes, carry) = expected_audio_bytes(delta, bps, align, 0.0);
        assert_eq!(bytes, align, "{bps}/{align} delta {delta}");
        assert_eq!(carry, 0.0, "{bps}/{align} delta {delta}");
      }
    }
  }

  #[test]
  fn a_non_finite_carry_is_discarded_for_every_format() {
    for (bps, align) in FORMATS {
      for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1e9] {
        let (bytes, carry) = expected_audio_bytes(166_667, bps, align, bad);
        assert!(bytes % align == 0, "{bps}/{align} carry {bad}");
        assert!(carry.is_finite(), "{bps}/{align} carry {bad}");
        assert!(bytes >= align, "{bps}/{align} carry {bad}");
      }
    }
  }

  #[test]
  fn a_degenerate_block_size_never_divides_by_zero() {
    for bps in [0usize, 1, 192_000] {
      let (bytes, carry) = expected_audio_bytes(166_667, bps, 0, 0.0);
      assert!(bytes > 0, "{bps}");
      assert!(carry.is_finite(), "{bps}");
    }
  }

  #[test]
  fn the_budget_scales_with_the_byte_rate_at_every_alignment() {
    for align in [1usize, 2, 4, 8] {
      let (small, _) = expected_audio_bytes(10_000_000, 48_000, align, 0.0);
      let (large, _) = expected_audio_bytes(10_000_000, 192_000, align, 0.0);
      assert_eq!(large, small * 4, "align {align}");
    }
  }
}

// -- geometry ----------------------------------------------------------------

mod geometry_matrix {
  use super::*;

  const CANVASES: [(u32, u32); 7] = [
    (1920, 1080),
    (1280, 720),
    (3840, 2160),
    (1080, 1920),
    (800, 800),
    (1, 1),
    (100, 4000),
  ];

  const ANCHORS: [OverlayAnchor; 4] = [
    OverlayAnchor::TopLeft,
    OverlayAnchor::TopRight,
    OverlayAnchor::BottomLeft,
    OverlayAnchor::BottomRight,
  ];

  const RATIOS: [f32; 7] = [0.0, 0.05, 0.25, 0.5, 0.95, 2.0, -1.0];
  const ASPECTS: [f32; 7] = [16.0 / 9.0, 4.0 / 3.0, 1.0, 9.0 / 16.0, 10.0, 0.1, f32::NAN];
  const MARGINS: [u32; 5] = [0, 8, 32, 500, 100_000];

  #[test]
  fn the_overlay_always_stays_on_the_canvas_in_every_cell() {
    for (w, h) in CANVASES {
      for ratio in RATIOS {
        for aspect in ASPECTS {
          for margin in MARGINS {
            for anchor in ANCHORS {
              let r = compute_overlay_rect(w, h, ratio, aspect, margin, anchor);
              let label = format!("{w}x{h} ratio {ratio} aspect {aspect} margin {margin} {anchor:?}");
              assert!(r.x + r.width <= w, "{label}");
              assert!(r.y + r.height <= h, "{label}");
            }
          }
        }
      }
    }
  }

  #[test]
  fn the_overlay_never_has_a_zero_side_on_a_real_canvas() {
    for (w, h) in CANVASES {
      for ratio in RATIOS {
        for aspect in ASPECTS {
          for margin in MARGINS {
            let r = compute_overlay_rect(w, h, ratio, aspect, margin, OverlayAnchor::TopLeft);
            let label = format!("{w}x{h} ratio {ratio} aspect {aspect} margin {margin}");
            assert!(r.width >= 1, "{label}");
            assert!(r.height >= 1, "{label}");
          }
        }
      }
    }
  }

  #[test]
  fn every_anchor_produces_the_same_box_in_a_different_corner() {
    for (w, h) in CANVASES {
      for ratio in [0.05f32, 0.25, 0.5] {
        for margin in [0u32, 8, 32] {
          let first = compute_overlay_rect(w, h, ratio, 16.0 / 9.0, margin, ANCHORS[0]);
          for anchor in ANCHORS {
            let r = compute_overlay_rect(w, h, ratio, 16.0 / 9.0, margin, anchor);
            let label = format!("{w}x{h} ratio {ratio} margin {margin} {anchor:?}");
            assert_eq!(r.width, first.width, "{label}");
            assert_eq!(r.height, first.height, "{label}");
          }
        }
      }
    }
  }

  #[test]
  fn a_canvas_with_no_pixels_gives_an_empty_overlay_for_every_setting() {
    for ratio in RATIOS {
      for aspect in ASPECTS {
        for anchor in ANCHORS {
          for (w, h) in [(0u32, 1080u32), (1920, 0), (0, 0)] {
            let r = compute_overlay_rect(w, h, ratio, aspect, 32, anchor);
            assert_eq!((r.x, r.y, r.width, r.height), (0, 0, 0, 0), "{w}x{h}");
          }
        }
      }
    }
  }

  #[test]
  fn a_bigger_ratio_never_gives_a_smaller_box() {
    for (w, h) in CANVASES {
      for aspect in [16.0f32 / 9.0, 1.0, 9.0 / 16.0] {
        let mut last = 0u32;
        for ratio in [0.05f32, 0.15, 0.3, 0.5, 0.75, 0.95] {
          let r = compute_overlay_rect(w, h, ratio, aspect, 0, OverlayAnchor::TopLeft);
          assert!(r.height >= last, "{w}x{h} aspect {aspect} ratio {ratio}");
          last = r.height;
        }
      }
    }
  }

  #[test]
  fn a_bigger_margin_never_gives_a_bigger_box() {
    for (w, h) in CANVASES {
      let mut last = u32::MAX;
      for margin in [0u32, 8, 32, 200, 500] {
        let r = compute_overlay_rect(w, h, 0.5, 16.0 / 9.0, margin, OverlayAnchor::TopLeft);
        assert!(r.width <= last, "{w}x{h} margin {margin}");
        last = r.width;
      }
    }
  }

  #[test]
  fn a_non_finite_aspect_falls_back_to_portrait_at_every_canvas() {
    for (w, h) in [(1920u32, 1080u32), (1280, 720), (800, 800)] {
      for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.0, -1.0] {
        let r = compute_overlay_rect(w, h, 0.25, bad, 8, OverlayAnchor::TopLeft);
        let got = r.width as f64 / r.height as f64;
        assert!((got - 9.0 / 16.0).abs() < 0.05, "{w}x{h} aspect {bad}: {got}");
      }
    }
  }

  #[test]
  fn the_crop_always_fits_inside_the_source_in_every_cell() {
    let sizes = [
      (1920u32, 1080u32),
      (1080, 1920),
      (640, 640),
      (1, 1),
      (4000, 3),
      (3, 4000),
    ];
    for (sw, sh) in sizes {
      for (dw, dh) in sizes {
        let crop = compute_center_crop_rect(sw, sh, dw, dh);
        let label = format!("{sw}x{sh} -> {dw}x{dh}");
        assert!(crop.x + crop.width <= sw, "{label}");
        assert!(crop.y + crop.height <= sh, "{label}");
        assert!(crop.width >= 1, "{label}");
        assert!(crop.height >= 1, "{label}");
      }
    }
  }

  #[test]
  fn the_crop_is_centred_in_every_cell() {
    let sizes = [(1920u32, 1080u32), (1080, 1920), (640, 640), (2560, 1080)];
    for (sw, sh) in sizes {
      for (dw, dh) in sizes {
        let crop = compute_center_crop_rect(sw, sh, dw, dh);
        let label = format!("{sw}x{sh} -> {dw}x{dh}");
        // Off by at most one from integer division.
        let left = crop.x;
        let right = sw - crop.x - crop.width;
        assert!(left.abs_diff(right) <= 1, "{label}: {left} vs {right}");
        let top = crop.y;
        let bottom = sh - crop.y - crop.height;
        assert!(top.abs_diff(bottom) <= 1, "{label}: {top} vs {bottom}");
      }
    }
  }

  #[test]
  fn the_crop_takes_the_targets_aspect_ratio_in_every_reasonable_cell() {
    let sizes = [(1920u32, 1080u32), (1080, 1920), (640, 640), (2560, 1080)];
    for (sw, sh) in sizes {
      for (dw, dh) in sizes {
        let crop = compute_center_crop_rect(sw, sh, dw, dh);
        let got = crop.width as f64 / crop.height as f64;
        let want = dw as f64 / dh as f64;
        assert!(
          (got / want - 1.0).abs() < 0.02,
          "{sw}x{sh} -> {dw}x{dh}: {got} vs {want}"
        );
      }
    }
  }

  #[test]
  fn the_crop_only_depends_on_the_targets_ratio_not_its_size() {
    let sizes = [(1920u32, 1080u32), (1080, 1920), (640, 640)];
    for (sw, sh) in sizes {
      let a = compute_center_crop_rect(sw, sh, 1920, 1080);
      let b = compute_center_crop_rect(sw, sh, 640, 360);
      assert_eq!(a, b, "{sw}x{sh}");
    }
  }

  #[test]
  fn a_degenerate_size_gives_an_empty_crop_in_every_cell() {
    for (sw, sh) in [(0u32, 1080u32), (1920, 0), (0, 0)] {
      for (dw, dh) in [(1920u32, 1080u32), (0, 0)] {
        let crop = compute_center_crop_rect(sw, sh, dw, dh);
        assert_eq!((crop.x, crop.y, crop.width, crop.height), (0, 0, 0, 0));
      }
    }
    for (dw, dh) in [(0u32, 1080u32), (1920, 0)] {
      let crop = compute_center_crop_rect(1920, 1080, dw, dh);
      assert_eq!((crop.width, crop.height), (0, 0), "{dw}x{dh}");
    }
  }

  #[test]
  fn the_drop_percentage_is_bounded_across_the_matrix() {
    for total in [0u64, 1, 60, 3_600, 1_000_000, u64::MAX] {
      for dropped in [0u64, 1, 30, 3_600, 1_000_000, u64::MAX] {
        let value = compute_frame_drop_stats(total, dropped);
        assert!(value.is_finite(), "{total}/{dropped}");
        assert!((0.0..=100.0).contains(&value), "{total}/{dropped}: {value}");
      }
    }
  }

  #[test]
  fn the_drop_percentage_rises_with_the_drop_count_at_every_total() {
    for total in [1u64, 60, 3_600, 1_000_000] {
      let mut last = -1.0;
      for numerator in 0..=10 {
        let dropped = total * numerator / 10;
        let value = compute_frame_drop_stats(total, dropped);
        assert!(value >= last, "total {total} dropped {dropped}");
        last = value;
      }
    }
  }
}
