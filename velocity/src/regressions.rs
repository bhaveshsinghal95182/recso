//! Regressions.
//!
//! One test per defect this crate has actually had. Named after the symptom
//! rather than the fix, because the point of a regression test is to fail with
//! a description of what the user would have seen -- not with a restatement of
//! the patch that stopped it.
//!
//! Each one carries the reasoning that made it a bug, so the next person to
//! touch that line can tell whether their change reintroduces it.

// -- audio slid out of sync over a long recording ---------------------------

mod audio_drifted_behind_the_picture {
  use crate::singular_clock::{expected_audio_bytes, fps_to_period_100ns};

  /// 44.1kHz stereo 16-bit: the format the drift was worst in.
  const CD_STEREO: (usize, usize) = (176_400, 4);

  /// What `frames` frames of `period` are worth, measured against the clock.
  fn owed(frames: u64, period_100ns: i64, bytes_per_second: usize) -> i64 {
    let elapsed = frames as f64 * period_100ns as f64 / 10_000_000.0;
    (elapsed * bytes_per_second as f64).round() as i64
  }

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
  fn the_per_frame_budget_does_not_quietly_lose_a_sample_frame() {
    // 44.1kHz stereo at 24fps wants exactly 7350 bytes a frame. 7350 is not a
    // multiple of the 4-byte block, so the budget hands over 7348 -- and the
    // carry used to be computed *before* that truncation, so the missing two
    // bytes were never owed to anyone. Two bytes a frame is 48 a second, which
    // is about a second of audio lost per hour of recording.
    let (bps, align) = CD_STEREO;
    let period = fps_to_period_100ns(24);
    let (bytes, carry) = expected_audio_bytes(period, bps, align, 0.0);
    assert_eq!(bytes % align, 0, "the budget must stay block aligned");
    assert!(
      carry >= 1.0,
      "the bytes alignment could not hand over have to be carried, not dropped: {carry}"
    );
  }

  #[test]
  fn a_minute_of_recording_does_not_lose_audible_audio() {
    let (bps, align) = CD_STEREO;
    let period = fps_to_period_100ns(24);
    let frames = 24 * 60;
    let drift = (run(frames, period, bps, align) - owed(frames, period, bps)).abs();
    // It used to be about 2900 bytes -- some 16ms of sound, and growing.
    assert!(drift <= align as i64 * 2, "a minute drifted by {drift} bytes");
  }

  #[test]
  fn an_hour_of_recording_does_not_drift_further_than_a_minute() {
    // The property that distinguishes a bounded rounding residue from a
    // per-frame leak: a leak is sixty times worse over sixty times the frames.
    let (bps, align) = CD_STEREO;
    let period = fps_to_period_100ns(24);
    let minute = (run(24 * 60, period, bps, align) - owed(24 * 60, period, bps)).abs();
    let hour = (run(24 * 3_600, period, bps, align) - owed(24 * 3_600, period, bps)).abs();
    assert!(
      hour <= minute.max(align as i64 * 2),
      "a minute drifted {minute} bytes, an hour drifted {hour}"
    );
  }

  #[test]
  fn no_realistic_format_and_rate_pairing_leaks() {
    let formats = [(192_000usize, 4usize), (176_400, 4), (384_000, 8), (96_000, 2)];
    for (bps, align) in formats {
      for fps in [24u32, 25, 30, 50, 60, 120] {
        let period = fps_to_period_100ns(fps);
        let frames = (fps * 120) as u64;
        let drift = (run(frames, period, bps, align) - owed(frames, period, bps)).abs();
        assert!(
          drift <= align as i64 * 2,
          "{bps}/{align} at {fps}fps drifted {drift} bytes over two minutes"
        );
      }
    }
  }
}

// -- the process died on an extreme timestamp -------------------------------

mod an_extreme_tick_took_the_process_down {
  use crate::singular_clock::*;

  #[test]
  fn the_closest_camera_frame_can_be_asked_for_at_any_tick() {
    // `saturating_sub(...).abs()` looks overflow-safe and is not: a saturated
    // subtraction lands on i64::MIN, which has no positive counterpart, and
    // `abs` panics on it in debug. The saturating_sub was there precisely to
    // be defensive, so the magnitude had to be too.
    let ticks = [i64::MIN, i64::MIN + 1, 0, i64::MAX - 1, i64::MAX];
    for target in [i64::MIN, i64::MIN + 1, -1, 0, 1, i64::MAX - 1, i64::MAX] {
      for limit in [i64::MIN, 0, 1, 500, i64::MAX] {
        let _ = select_closest_webcam_tick(target, &ticks, limit);
      }
    }
  }

  #[test]
  fn a_pacing_decision_can_be_made_at_any_drift() {
    for drift in [i64::MIN, i64::MIN + 1, -1, 0, 1, i64::MAX - 1, i64::MAX] {
      for len in [0usize, 8, 16] {
        let _ = select_frame_action(drift, len, 16, 100_000, 1_000_000);
      }
    }
  }

  #[test]
  fn a_tick_can_be_quantised_at_any_value() {
    // `floor(raw / period) * period` is the largest multiple of the period at
    // or below the tick -- and below `i64::MIN` there is no such multiple, so
    // the multiply overflowed. Saturating clamps the grid rather than dying.
    for raw in [i64::MIN, i64::MIN + 1, -1, 0, 1, i64::MAX - 1, i64::MAX] {
      for period in [1i64, 1_000, 166_667, i64::MAX] {
        let snapped = quantize_tick_100ns(raw, period);
        // Whatever comes back, it is a real number the caller can use.
        assert!(snapped != 0 || raw.abs() < period, "{raw}/{period}");
      }
    }
  }

  #[test]
  fn a_tick_from_a_real_clock_still_lands_exactly_on_the_grid() {
    // The saturation above must not have loosened the ordinary case: every
    // period a real capture uses, across the range of ticks one produces.
    for fps in [24u32, 25, 30, 50, 60, 120, 240] {
      let period = fps_to_period_100ns(fps);
      for raw in [0i64, 1, 12_345, 166_666, 5_000_000, 36_000_000_000, -12_345] {
        assert_eq!(
          quantize_tick_100ns(raw, period) % period,
          0,
          "{fps}fps raw {raw}"
        );
      }
    }
  }

  #[test]
  fn the_extreme_drifts_still_resolve_to_a_resync() {
    // Not merely "does not panic": a stream this far out has to re-anchor.
    for drift in [i64::MIN, i64::MAX] {
      assert_eq!(
        select_frame_action(drift, 0, 16, 100_000, 1_000_000),
        FrameAction::ResyncWebcam,
        "{drift}"
      );
    }
  }
}
