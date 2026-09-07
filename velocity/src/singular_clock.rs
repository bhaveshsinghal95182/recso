pub const DEFAULT_FRAME_PERIOD_100NS: i64 = 166_667;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameAction {
  UseCurrent,
  UseLastWebcam,
  DropWebcam,
  ResyncWebcam,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayAnchor {
  BottomRight,
  BottomLeft,
  TopRight,
  TopLeft,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CropRect {
  pub x: u32,
  pub y: u32,
  pub width: u32,
  pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverlayRect {
  pub x: u32,
  pub y: u32,
  pub width: u32,
  pub height: u32,
}

pub fn fps_to_period_100ns(fps: u32) -> i64 {
  if fps == 0 {
    return DEFAULT_FRAME_PERIOD_100NS;
  }

  let safe_fps = fps.clamp(1, 240);
  let period = (10_000_000.0 / safe_fps as f64).round() as i64;
  period.max(1)
}

pub fn quantize_tick_100ns(raw_tick_100ns: i64, period_100ns: i64) -> i64 {
  if period_100ns <= 0 {
    return raw_tick_100ns;
  }

  let period = period_100ns.abs();
  // `saturating_mul` for the same reason the subtractions below saturate: the
  // largest multiple of `period` at or below `i64::MIN` is itself below
  // `i64::MIN` unless the two divide exactly, so the obvious multiply
  // overflows at the bottom of the range. Saturating clamps the grid instead
  // of panicking -- a tick that extreme is not a real timestamp, but the rest
  // of this function is written to survive one and this was the hole in it.
  let lower = raw_tick_100ns.div_euclid(period).saturating_mul(period);
  let upper = lower.saturating_add(period);

  // `saturating_abs` rather than `abs`: a saturated subtraction lands on
  // i64::MIN, which has no positive counterpart and panics on `abs`. Guarding
  // the subtraction and not the magnitude would only move the overflow.
  let distance_to_lower = raw_tick_100ns.saturating_sub(lower).saturating_abs();
  let distance_to_upper = upper.saturating_sub(raw_tick_100ns).saturating_abs();

  if distance_to_lower <= distance_to_upper {
    lower
  } else {
    upper
  }
}

pub fn next_tick_100ns(previous_tick_100ns: i64, period_100ns: i64) -> i64 {
  previous_tick_100ns.saturating_add(period_100ns.max(1))
}

pub fn drift_100ns(actual_tick_100ns: i64, expected_tick_100ns: i64) -> i64 {
  actual_tick_100ns.saturating_sub(expected_tick_100ns)
}

pub fn delta_100ns_or_default(
  previous_tick_100ns: Option<i64>,
  current_tick_100ns: i64,
  fallback_100ns: i64,
) -> i64 {
  let safe_fallback = fallback_100ns.max(1);

  match previous_tick_100ns {
    Some(previous_tick) if current_tick_100ns > previous_tick => {
      current_tick_100ns.saturating_sub(previous_tick)
    }
    _ => safe_fallback,
  }
}

pub fn expected_audio_bytes(
  delta_100ns: i64,
  bytes_per_second: usize,
  block_align: usize,
  carry_fraction: f64,
) -> (usize, f64) {
  let safe_block_align = block_align.max(1);
  let safe_bytes_per_second = bytes_per_second.max(safe_block_align);
  let safe_delta = delta_100ns.max(1) as f64;
  let safe_carry = if carry_fraction.is_finite() {
    carry_fraction.max(0.0)
  } else {
    0.0
  };

  let mut expected_with_fraction =
    (safe_delta / 10_000_000.0) * safe_bytes_per_second as f64 + safe_carry;
  if !expected_with_fraction.is_finite() || expected_with_fraction <= 0.0 {
    expected_with_fraction = safe_block_align as f64;
  }

  let mut expected_bytes = expected_with_fraction.floor() as usize;

  if expected_bytes < safe_block_align {
    // Never hand the encoder less than one whole sample frame -- that stalls
    // the stream rather than producing a shorter one. We gave more than was
    // owed, so nothing carries forward.
    return (safe_block_align, 0.0);
  }

  expected_bytes -= expected_bytes % safe_block_align;

  // The carry is everything that was owed but not handed over: the fraction of
  // a byte *and* the whole bytes lost to block alignment.
  //
  // Taking it before the alignment step instead -- which is what this used to
  // do -- silently drops up to one sample frame per video frame. At 44.1kHz
  // stereo and 24fps the budget is exactly 7350 bytes, which is not a multiple
  // of the 4-byte block, so two bytes went missing every frame: about a second
  // of audio drift per hour, which is heard as the sound sliding out of sync
  // rather than seen as anything.
  let next_carry = expected_with_fraction - expected_bytes as f64;

  (expected_bytes, next_carry)
}

pub fn queue_pressure_ratio(queue_len: usize, queue_capacity: usize) -> f64 {
  if queue_capacity == 0 {
    return 0.0;
  }

  let ratio = queue_len as f64 / queue_capacity as f64;
  ratio.clamp(0.0, 1.0)
}

pub fn select_frame_action(
  drift_100ns: i64,
  queue_len: usize,
  queue_capacity: usize,
  late_threshold_100ns: i64,
  resync_threshold_100ns: i64,
) -> FrameAction {
  let safe_late_threshold = late_threshold_100ns.max(1);
  let safe_resync_threshold = resync_threshold_100ns.max(safe_late_threshold + 1);
  let abs_drift = drift_100ns.saturating_abs();

  if abs_drift >= safe_resync_threshold {
    return FrameAction::ResyncWebcam;
  }

  if abs_drift <= safe_late_threshold {
    return FrameAction::UseCurrent;
  }

  let pressure = queue_pressure_ratio(queue_len, queue_capacity);

  if drift_100ns > safe_late_threshold {
    if pressure >= 0.85 {
      FrameAction::DropWebcam
    } else {
      FrameAction::UseLastWebcam
    }
  } else if pressure >= 0.95 {
    FrameAction::DropWebcam
  } else {
    FrameAction::UseCurrent
  }
}

pub fn should_resync_after_misses(consecutive_misses: u32, miss_threshold: u32) -> bool {
  miss_threshold > 0 && consecutive_misses >= miss_threshold
}

pub fn select_closest_webcam_tick(
  target_tick_100ns: i64,
  webcam_ticks_100ns: &[i64],
  max_abs_drift_100ns: i64,
) -> Option<usize> {
  if webcam_ticks_100ns.is_empty() {
    return None;
  }

  let max_abs_drift = max_abs_drift_100ns.max(0);
  let mut best_index: Option<usize> = None;
  let mut best_abs_drift: i64 = i64::MAX;
  let mut best_tick = i64::MAX;

  for (index, tick) in webcam_ticks_100ns.iter().enumerate() {
    let abs_drift = tick.saturating_sub(target_tick_100ns).saturating_abs();
    if abs_drift > max_abs_drift {
      continue;
    }

    let is_better = abs_drift < best_abs_drift || (abs_drift == best_abs_drift && *tick < best_tick);

    if is_better {
      best_index = Some(index);
      best_abs_drift = abs_drift;
      best_tick = *tick;
    }
  }

  best_index
}

pub fn is_monotonic_tick_sequence(ticks: &[i64]) -> bool {
  ticks.windows(2).all(|window| window[1] >= window[0])
}

pub fn compute_center_crop_rect(src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> CropRect {
  if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
    return CropRect {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
  }

  let source_aspect = src_w as f64 / src_h as f64;
  let target_aspect = dst_w as f64 / dst_h as f64;

  if source_aspect > target_aspect {
    let crop_width = ((src_h as f64 * target_aspect).round() as u32).clamp(1, src_w);
    CropRect {
      x: (src_w - crop_width) / 2,
      y: 0,
      width: crop_width,
      height: src_h,
    }
  } else if source_aspect < target_aspect {
    let crop_height = ((src_w as f64 / target_aspect).round() as u32).clamp(1, src_h);
    CropRect {
      x: 0,
      y: (src_h - crop_height) / 2,
      width: src_w,
      height: crop_height,
    }
  } else {
    CropRect {
      x: 0,
      y: 0,
      width: src_w,
      height: src_h,
    }
  }
}

pub fn compute_overlay_rect(
  canvas_w: u32,
  canvas_h: u32,
  height_ratio: f32,
  aspect_ratio: f32,
  margin_px: u32,
  anchor: OverlayAnchor,
) -> OverlayRect {
  if canvas_w == 0 || canvas_h == 0 {
    return OverlayRect {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
  }

  let safe_height_ratio = f64::from(height_ratio.clamp(0.05, 0.95));
  let safe_aspect_ratio = if aspect_ratio.is_finite() && aspect_ratio > 0.0 {
    f64::from(aspect_ratio)
  } else {
    9.0 / 16.0
  };

  let max_margin = (canvas_w.min(canvas_h)) / 2;
  let margin = margin_px.min(max_margin);

  let mut height = ((canvas_h as f64) * safe_height_ratio).round() as u32;
  height = height.max(1);
  let mut width = ((height as f64) * safe_aspect_ratio).round() as u32;
  width = width.max(1);

  let max_width = canvas_w.saturating_sub(margin.saturating_mul(2)).max(1);
  let max_height = canvas_h.saturating_sub(margin.saturating_mul(2)).max(1);

  if width > max_width {
    width = max_width;
    height = ((f64::from(width)) / safe_aspect_ratio).round() as u32;
    height = height.max(1);
  }

  if height > max_height {
    height = max_height;
    width = ((f64::from(height)) * safe_aspect_ratio).round() as u32;
    width = width.max(1);
  }

  let max_x = canvas_w.saturating_sub(width);
  let max_y = canvas_h.saturating_sub(height);

  let (x, y) = match anchor {
    OverlayAnchor::BottomRight => (
      canvas_w.saturating_sub(width).saturating_sub(margin),
      canvas_h.saturating_sub(height).saturating_sub(margin),
    ),
    OverlayAnchor::BottomLeft => (margin, canvas_h.saturating_sub(height).saturating_sub(margin)),
    OverlayAnchor::TopRight => (canvas_w.saturating_sub(width).saturating_sub(margin), margin),
    OverlayAnchor::TopLeft => (margin, margin),
  };

  OverlayRect {
    x: x.min(max_x),
    y: y.min(max_y),
    width,
    height,
  }
}

pub fn compute_effective_webcam_tick(raw_webcam_tick_100ns: i64, clock_period_100ns: i64) -> i64 {
  quantize_tick_100ns(raw_webcam_tick_100ns, clock_period_100ns)
}

pub fn compute_frame_drop_stats(total_frames: u64, dropped_frames: u64) -> f64 {
  if total_frames == 0 {
    return 0.0;
  }

  let ratio = dropped_frames as f64 / total_frames as f64;
  (ratio * 100.0).clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_fps_to_period_100ns_returns_166667_for_60() {
    assert_eq!(fps_to_period_100ns(60), 166_667);
  }

  #[test]
  fn test_fps_to_period_100ns_returns_333333_for_30() {
    assert_eq!(fps_to_period_100ns(30), 333_333);
  }

  #[test]
  fn test_fps_to_period_100ns_clamps_zero_to_default() {
    assert_eq!(fps_to_period_100ns(0), DEFAULT_FRAME_PERIOD_100NS);
  }

  #[test]
  fn test_quantize_tick_100ns_rounds_to_boundary() {
    assert_eq!(quantize_tick_100ns(499, 100), 500);
  }

  #[test]
  fn test_quantize_tick_100ns_handles_negative_values() {
    assert_eq!(quantize_tick_100ns(-151, 100), -200);
  }

  #[test]
  fn test_next_tick_100ns_advances_by_period() {
    assert_eq!(next_tick_100ns(1_000, 166_667), 167_667);
  }

  #[test]
  fn test_drift_100ns_sign_and_magnitude() {
    assert_eq!(drift_100ns(1_250, 1_000), 250);
    assert_eq!(drift_100ns(900, 1_000), -100);
  }

  #[test]
  fn test_delta_100ns_or_default_uses_fallback_on_first_tick() {
    assert_eq!(delta_100ns_or_default(None, 2_000, 333_333), 333_333);
  }

  #[test]
  fn test_delta_100ns_or_default_uses_fallback_on_non_monotonic_tick() {
    assert_eq!(delta_100ns_or_default(Some(2_000), 1_900, 166_667), 166_667);
  }

  #[test]
  fn test_expected_audio_bytes_block_aligned() {
    let (bytes, _) = expected_audio_bytes(166_667, 192_000, 4, 0.0);
    assert_eq!(bytes % 4, 0);
  }

  #[test]
  fn test_expected_audio_bytes_preserves_fractional_carry() {
    let (_, carry) = expected_audio_bytes(166_667, 192_000, 4, 0.35);
    assert!(carry >= 0.0);
    assert!(carry < 1.0);
  }

  #[test]
  fn test_expected_audio_bytes_handles_small_delta() {
    let (bytes, _) = expected_audio_bytes(1, 192_000, 4, 0.0);
    assert!(bytes >= 4);
  }

  #[test]
  fn test_queue_pressure_ratio_bounds() {
    assert_eq!(queue_pressure_ratio(5, 10), 0.5);
    assert_eq!(queue_pressure_ratio(12, 10), 1.0);
  }

  #[test]
  fn test_queue_pressure_ratio_zero_capacity_is_zero() {
    assert_eq!(queue_pressure_ratio(5, 0), 0.0);
  }

  #[test]
  fn test_select_frame_action_on_time_uses_current() {
    let action = select_frame_action(500, 1, 10, 1_000, 10_000);
    assert_eq!(action, FrameAction::UseCurrent);
  }

  #[test]
  fn test_select_frame_action_small_late_uses_last() {
    let action = select_frame_action(2_000, 1, 10, 1_000, 10_000);
    assert_eq!(action, FrameAction::UseLastWebcam);
  }

  #[test]
  fn test_select_frame_action_large_late_resyncs() {
    let action = select_frame_action(20_000, 1, 10, 1_000, 10_000);
    assert_eq!(action, FrameAction::ResyncWebcam);
  }

  #[test]
  fn test_should_resync_after_misses_at_threshold() {
    assert!(should_resync_after_misses(3, 3));
  }

  #[test]
  fn test_should_resync_after_misses_below_threshold() {
    assert!(!should_resync_after_misses(2, 3));
  }

  #[test]
  fn test_select_closest_webcam_tick_prefers_nearest() {
    let ticks = [100, 200, 300];
    assert_eq!(select_closest_webcam_tick(240, &ticks, 80), Some(1));
  }

  #[test]
  fn test_select_closest_webcam_tick_returns_none_when_out_of_range() {
    let ticks = [100, 200, 300];
    assert_eq!(select_closest_webcam_tick(240, &ticks, 20), None);
  }

  #[test]
  fn test_select_closest_webcam_tick_tie_breaks_to_earlier() {
    let ticks = [100, 300];
    assert_eq!(select_closest_webcam_tick(200, &ticks, 150), Some(0));
  }

  #[test]
  fn test_is_monotonic_tick_sequence_true_for_sorted() {
    assert!(is_monotonic_tick_sequence(&[1, 2, 2, 4]));
  }

  #[test]
  fn test_is_monotonic_tick_sequence_false_for_regression() {
    assert!(!is_monotonic_tick_sequence(&[1, 3, 2, 4]));
  }

  #[test]
  fn test_compute_center_crop_rect_for_wider_source() {
    let rect = compute_center_crop_rect(1920, 1080, 607, 1080);
    assert!(rect.width < 1920);
    assert_eq!(rect.height, 1080);
    assert_eq!(rect.y, 0);
  }

  #[test]
  fn test_compute_center_crop_rect_for_taller_source() {
    let rect = compute_center_crop_rect(1080, 1920, 1080, 607);
    assert_eq!(rect.width, 1080);
    assert!(rect.height < 1920);
    assert_eq!(rect.x, 0);
  }

  #[test]
  fn test_compute_center_crop_rect_for_equal_aspect() {
    let rect = compute_center_crop_rect(1280, 720, 1920, 1080);
    assert_eq!(rect.x, 0);
    assert_eq!(rect.y, 0);
    assert_eq!(rect.width, 1280);
    assert_eq!(rect.height, 720);
  }

  #[test]
  fn test_compute_overlay_rect_bottom_right_default() {
    let rect = compute_overlay_rect(1920, 1080, 0.28, 9.0 / 16.0, 24, OverlayAnchor::BottomRight);
    assert_eq!(rect.x + rect.width + 24, 1920);
    assert_eq!(rect.y + rect.height + 24, 1080);
  }

  #[test]
  fn test_compute_overlay_rect_clamps_to_canvas() {
    let rect = compute_overlay_rect(100, 100, 0.9, 2.0, 40, OverlayAnchor::BottomRight);
    assert!(rect.x + rect.width <= 100);
    assert!(rect.y + rect.height <= 100);
  }

  #[test]
  fn test_compute_effective_webcam_tick_quantization() {
    assert_eq!(compute_effective_webcam_tick(173_000, 166_667), 166_667);
  }

  #[test]
  fn test_compute_frame_drop_stats_percentage() {
    assert_eq!(compute_frame_drop_stats(200, 5), 2.5);
  }
}

#[cfg(test)]
mod period_scenarios {
  use super::*;

  #[test]
  fn test_fps_to_period_covers_the_common_frame_rates() {
    // Rounded to the nearest 100ns tick, which is the unit Media Foundation
    // and the capture stack both speak.
    assert_eq!(fps_to_period_100ns(24), 416_667);
    assert_eq!(fps_to_period_100ns(25), 400_000);
    assert_eq!(fps_to_period_100ns(30), 333_333);
    assert_eq!(fps_to_period_100ns(50), 200_000);
    assert_eq!(fps_to_period_100ns(60), 166_667);
    assert_eq!(fps_to_period_100ns(120), 83_333);
  }

  #[test]
  fn test_fps_to_period_at_one_frame_per_second_is_a_whole_second() {
    assert_eq!(fps_to_period_100ns(1), 10_000_000);
  }

  #[test]
  fn test_fps_to_period_clamps_the_top_end_to_240() {
    let ceiling = fps_to_period_100ns(240);
    assert_eq!(fps_to_period_100ns(1000), ceiling);
    assert_eq!(fps_to_period_100ns(u32::MAX), ceiling);
  }

  #[test]
  fn test_fps_to_period_never_returns_a_non_positive_period() {
    // A zero period would make `next_tick` stand still and the capture loop
    // spin forever on the same timestamp.
    for fps in [0u32, 1, 30, 60, 240, 10_000, u32::MAX] {
      assert!(fps_to_period_100ns(fps) > 0, "{fps}");
    }
  }

  #[test]
  fn test_fps_to_period_is_monotonic_in_fps() {
    let mut last = i64::MAX;
    for fps in 1..=240u32 {
      let period = fps_to_period_100ns(fps);
      assert!(period <= last, "{fps}: {period} > {last}");
      last = period;
    }
  }

  #[test]
  fn test_fps_to_period_round_trips_back_to_roughly_the_frame_rate() {
    for fps in [24u32, 25, 30, 50, 60, 120, 240] {
      let recovered = 10_000_000.0 / fps_to_period_100ns(fps) as f64;
      assert!((recovered - fps as f64).abs() < 0.01, "{fps}: {recovered}");
    }
  }

  #[test]
  fn test_zero_fps_falls_back_to_the_60fps_default() {
    assert_eq!(fps_to_period_100ns(0), DEFAULT_FRAME_PERIOD_100NS);
    assert_eq!(DEFAULT_FRAME_PERIOD_100NS, fps_to_period_100ns(60));
  }
}

#[cfg(test)]
mod quantize_scenarios {
  use super::*;

  const P: i64 = 166_667;

  #[test]
  fn test_quantize_leaves_a_tick_already_on_a_boundary() {
    for multiple in [0i64, 1, 2, 17, 1000] {
      assert_eq!(quantize_tick_100ns(P * multiple, P), P * multiple, "{multiple}");
    }
  }

  #[test]
  fn test_quantize_rounds_down_from_just_past_a_boundary() {
    assert_eq!(quantize_tick_100ns(P + 10, P), P);
  }

  #[test]
  fn test_quantize_rounds_up_from_just_before_a_boundary() {
    assert_eq!(quantize_tick_100ns(2 * P - 10, P), 2 * P);
  }

  #[test]
  fn test_quantize_breaks_an_exact_tie_downwards() {
    // Ties go to the lower boundary, so a stream sitting exactly between two
    // ticks does not alternate between them frame to frame.
    assert_eq!(quantize_tick_100ns(500, 1000), 0);
    assert_eq!(quantize_tick_100ns(1500, 1000), 1000);
  }

  #[test]
  fn test_quantize_handles_negative_ticks() {
    assert_eq!(quantize_tick_100ns(-100, 1000), 0);
    assert_eq!(quantize_tick_100ns(-900, 1000), -1000);
    assert_eq!(quantize_tick_100ns(-1000, 1000), -1000);
  }

  #[test]
  fn test_quantize_uses_floor_division_rather_than_truncation() {
    // Truncating toward zero would make the boundary either side of the origin
    // twice as wide as every other one.
    assert_eq!(quantize_tick_100ns(-1400, 1000), -1000);
    assert_eq!(quantize_tick_100ns(-1600, 1000), -2000);
  }

  #[test]
  fn test_quantize_with_no_period_passes_the_tick_through() {
    assert_eq!(quantize_tick_100ns(123_456, 0), 123_456);
  }

  #[test]
  fn test_quantize_with_a_negative_period_passes_the_tick_through() {
    // The early return catches it before the `abs()` further down, so a
    // negative period is a no-op rather than a mirrored grid.
    assert_eq!(quantize_tick_100ns(123_456, -1000), 123_456);
  }

  #[test]
  fn test_quantize_result_is_always_on_the_grid() {
    for raw in [-5000i64, -1, 0, 1, 999, 1000, 123_456, 9_999_999] {
      assert_eq!(quantize_tick_100ns(raw, 1000) % 1000, 0, "{raw}");
    }
  }

  #[test]
  fn test_quantize_never_moves_a_tick_more_than_half_a_period() {
    for raw in [-5000i64, -1, 0, 1, 999, 123_456, 9_999_999] {
      let moved = (quantize_tick_100ns(raw, P) - raw).abs();
      assert!(moved <= P / 2 + 1, "{raw}: moved {moved}");
    }
  }

  #[test]
  fn test_quantize_is_idempotent() {
    for raw in [-5000i64, 0, 999, 123_456, 9_999_999] {
      let once = quantize_tick_100ns(raw, P);
      assert_eq!(quantize_tick_100ns(once, P), once, "{raw}");
    }
  }

  #[test]
  fn test_quantize_is_monotonic() {
    let mut last = i64::MIN;
    for step in 0..200 {
      let value = quantize_tick_100ns(step * 5000, P);
      assert!(value >= last, "step {step}");
      last = value;
    }
  }

  #[test]
  fn test_quantize_near_the_top_of_the_range_does_not_overflow() {
    let value = quantize_tick_100ns(i64::MAX - 10, 1000);
    assert!(value.is_positive());
  }

  #[test]
  fn test_effective_webcam_tick_is_the_quantized_tick() {
    // Named separately at the call site, but it had better stay the same
    // arithmetic -- the webcam and the desktop have to land on one grid.
    for raw in [0i64, 12_345, 166_666, 500_000] {
      assert_eq!(
        compute_effective_webcam_tick(raw, P),
        quantize_tick_100ns(raw, P),
        "{raw}"
      );
    }
  }

  #[test]
  fn test_effective_webcam_tick_pulls_a_jittery_camera_onto_the_grid() {
    // A camera reporting a few hundred ticks either side of the frame boundary
    // still lands on the same frame.
    for jitter in [-400i64, -50, 0, 50, 400] {
      assert_eq!(compute_effective_webcam_tick(P * 3 + jitter, P), P * 3, "{jitter}");
    }
  }
}

#[cfg(test)]
mod tick_arithmetic_scenarios {
  use super::*;

  #[test]
  fn test_next_tick_advances_by_exactly_one_period() {
    assert_eq!(next_tick_100ns(1_000_000, 166_667), 1_166_667);
  }

  #[test]
  fn test_next_tick_always_moves_forward() {
    // A zero or negative period would otherwise stall the loop on one tick.
    for period in [i64::MIN, -1000, -1, 0, 1] {
      assert!(next_tick_100ns(500, period) > 500, "{period}");
    }
  }

  #[test]
  fn test_next_tick_saturates_rather_than_wrapping() {
    assert_eq!(next_tick_100ns(i64::MAX, 166_667), i64::MAX);
  }

  #[test]
  fn test_next_tick_repeated_lands_on_the_grid() {
    let mut tick = 0;
    for _ in 0..60 {
      tick = next_tick_100ns(tick, 166_667);
    }
    assert_eq!(tick, 166_667 * 60);
  }

  #[test]
  fn test_drift_is_positive_when_the_frame_is_late() {
    assert_eq!(drift_100ns(1_200_000, 1_000_000), 200_000);
  }

  #[test]
  fn test_drift_is_negative_when_the_frame_is_early() {
    assert_eq!(drift_100ns(900_000, 1_000_000), -100_000);
  }

  #[test]
  fn test_drift_is_zero_when_the_frame_is_on_time() {
    assert_eq!(drift_100ns(1_000_000, 1_000_000), 0);
  }

  #[test]
  fn test_drift_saturates_rather_than_wrapping() {
    assert_eq!(drift_100ns(i64::MIN, i64::MAX), i64::MIN);
    assert_eq!(drift_100ns(i64::MAX, i64::MIN), i64::MAX);
  }

  #[test]
  fn test_delta_uses_the_gap_when_the_clock_moved_forward() {
    assert_eq!(delta_100ns_or_default(Some(1_000_000), 1_166_667, 999), 166_667);
  }

  #[test]
  fn test_delta_falls_back_on_the_first_tick() {
    assert_eq!(delta_100ns_or_default(None, 1_166_667, 166_667), 166_667);
  }

  #[test]
  fn test_delta_falls_back_when_the_clock_stood_still() {
    assert_eq!(delta_100ns_or_default(Some(1000), 1000, 42), 42);
  }

  #[test]
  fn test_delta_falls_back_when_the_clock_went_backwards() {
    assert_eq!(delta_100ns_or_default(Some(2000), 1000, 42), 42);
  }

  #[test]
  fn test_delta_never_returns_a_non_positive_value() {
    for fallback in [i64::MIN, -1000, 0] {
      assert!(delta_100ns_or_default(None, 0, fallback) > 0, "{fallback}");
      assert!(
        delta_100ns_or_default(Some(5000), 1000, fallback) > 0,
        "{fallback}"
      );
    }
  }

  #[test]
  fn test_delta_across_negative_ticks_still_measures_the_gap() {
    assert_eq!(delta_100ns_or_default(Some(-2000), -1000, 42), 1000);
  }

  #[test]
  fn test_a_sequence_of_deltas_sums_back_to_the_span() {
    let ticks = [0i64, 166_667, 333_334, 500_001, 666_668];
    let mut total = 0;
    let mut previous = None;
    for tick in ticks {
      if previous.is_some() {
        total += delta_100ns_or_default(previous, tick, 1);
      }
      previous = Some(tick);
    }
    assert_eq!(total, ticks[ticks.len() - 1] - ticks[0]);
  }
}

#[cfg(test)]
mod audio_budget_scenarios {
  use super::*;

  /// 48kHz stereo 16-bit: 4 bytes a frame, 192000 a second.
  const BPS: usize = 192_000;
  const ALIGN: usize = 4;

  #[test]
  fn test_one_frame_at_60fps_is_a_frames_worth_of_audio() {
    let (bytes, carry) = expected_audio_bytes(166_667, BPS, ALIGN, 0.0);
    assert_eq!(bytes, 3200);
    assert!(carry > 0.0 && carry < 1.0, "{carry}");
  }

  #[test]
  fn test_the_result_is_always_block_aligned() {
    // A partial sample frame handed to the encoder shifts every channel after
    // it, which is heard as a click rather than seen as a glitch.
    for delta in [1i64, 1000, 166_667, 333_333, 1_000_000, 10_000_000] {
      let (bytes, _) = expected_audio_bytes(delta, BPS, ALIGN, 0.0);
      assert_eq!(bytes % ALIGN, 0, "{delta}");
    }
  }

  #[test]
  fn test_the_result_is_aligned_for_every_block_size() {
    for align in [1usize, 2, 3, 4, 6, 8, 12, 16] {
      let (bytes, _) = expected_audio_bytes(166_667, BPS, align, 0.0);
      assert_eq!(bytes % align, 0, "align {align}");
    }
  }

  #[test]
  fn test_a_whole_second_is_a_seconds_worth_of_audio() {
    let (bytes, _) = expected_audio_bytes(10_000_000, BPS, ALIGN, 0.0);
    assert_eq!(bytes, BPS);
  }

  #[test]
  fn test_the_carry_keeps_the_fraction_that_did_not_fit() {
    // 60fps does not divide 48kHz evenly, so without the carry the audio would
    // drift about a millisecond behind every second.
    let (_, carry) = expected_audio_bytes(166_667, BPS, ALIGN, 0.0);
    assert!(carry > 0.0);
  }

  #[test]
  fn test_the_carry_is_spent_on_the_next_frame() {
    let mut carry = 0.0;
    let mut total = 0usize;
    for _ in 0..60 {
      let (bytes, next) = expected_audio_bytes(166_667, BPS, ALIGN, carry);
      total += bytes;
      carry = next;
    }
    // A second of frames should come to about a second of audio.
    let drift = (total as i64 - BPS as i64).abs();
    assert!(drift < ALIGN as i64 * 4, "{total} vs {BPS}, drift {drift}");
  }

  #[test]
  fn test_the_carry_stays_bounded_by_one_block() {
    // It is "bytes owed", not "fraction of a byte": it holds the sub-byte
    // remainder plus whatever the block alignment could not hand over, so it
    // is bounded by the block size rather than by 1.
    let mut carry = 0.0;
    for _ in 0..240 {
      let (_, next) = expected_audio_bytes(166_667, BPS, ALIGN, carry);
      assert!((0.0..(ALIGN as f64 + 1.0)).contains(&next), "{next}");
      carry = next;
    }
  }

  #[test]
  fn test_the_carry_recovers_the_bytes_alignment_could_not_hand_over() {
    // 44.1kHz stereo at 24fps wants exactly 7350 bytes a frame, which is not a
    // multiple of the 4-byte block. The two bytes that cannot be handed over
    // have to come back on a later frame rather than being lost.
    let period = fps_to_period_100ns(24);
    let mut carry = 0.0;
    let mut total = 0usize;
    for _ in 0..24 {
      let (bytes, next) = expected_audio_bytes(period, 176_400, 4, carry);
      total += bytes;
      carry = next;
    }
    // A second of frames comes to a second of audio, to within one block.
    assert!(
      (total as i64 - 176_400).abs() <= 4,
      "{total} vs 176400"
    );
  }

  #[test]
  fn test_a_tiny_delta_still_yields_at_least_one_block() {
    // The encoder is fed per frame; handing it nothing stalls the audio stream
    // rather than producing a shorter one.
    let (bytes, carry) = expected_audio_bytes(1, BPS, ALIGN, 0.0);
    assert_eq!(bytes, ALIGN);
    assert_eq!(carry, 0.0);
  }

  #[test]
  fn test_a_non_positive_delta_is_treated_as_the_smallest_one() {
    for delta in [i64::MIN, -1000, 0, 1] {
      let (bytes, _) = expected_audio_bytes(delta, BPS, ALIGN, 0.0);
      assert_eq!(bytes, ALIGN, "{delta}");
    }
  }

  #[test]
  fn test_a_non_finite_carry_is_thrown_away_rather_than_poisoning_the_budget() {
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
      let (bytes, carry) = expected_audio_bytes(166_667, BPS, ALIGN, bad);
      assert_eq!(bytes, 3200, "{bad}");
      assert!(carry.is_finite(), "{bad}");
    }
  }

  #[test]
  fn test_a_negative_carry_cannot_shrink_the_budget() {
    let (with_zero, _) = expected_audio_bytes(166_667, BPS, ALIGN, 0.0);
    let (with_negative, _) = expected_audio_bytes(166_667, BPS, ALIGN, -1000.0);
    assert_eq!(with_zero, with_negative);
  }

  #[test]
  fn test_a_zero_block_align_is_treated_as_one_byte() {
    let (bytes, _) = expected_audio_bytes(166_667, BPS, 0, 0.0);
    assert!(bytes > 0);
  }

  #[test]
  fn test_a_rate_below_the_block_size_is_raised_to_it() {
    let (bytes, _) = expected_audio_bytes(10_000_000, 1, ALIGN, 0.0);
    assert!(bytes >= ALIGN);
    assert_eq!(bytes % ALIGN, 0);
  }

  #[test]
  fn test_more_time_never_means_less_audio() {
    let mut last = 0usize;
    for step in 1..100 {
      let (bytes, _) = expected_audio_bytes(step * 100_000, BPS, ALIGN, 0.0);
      assert!(bytes >= last, "step {step}: {bytes} < {last}");
      last = bytes;
    }
  }

  #[test]
  fn test_mono_8_bit_is_handled_as_well_as_stereo_16() {
    let (bytes, _) = expected_audio_bytes(10_000_000, 8_000, 1, 0.0);
    assert_eq!(bytes, 8_000);
  }

  #[test]
  fn test_the_budget_scales_with_the_byte_rate() {
    let (small, _) = expected_audio_bytes(10_000_000, 48_000, ALIGN, 0.0);
    let (large, _) = expected_audio_bytes(10_000_000, 192_000, ALIGN, 0.0);
    assert_eq!(large, small * 4);
  }
}

#[cfg(test)]
mod pressure_scenarios {
  use super::*;

  #[test]
  fn test_an_empty_queue_is_no_pressure() {
    assert_eq!(queue_pressure_ratio(0, 16), 0.0);
  }

  #[test]
  fn test_a_full_queue_is_all_the_pressure_there_is() {
    assert_eq!(queue_pressure_ratio(16, 16), 1.0);
  }

  #[test]
  fn test_a_half_full_queue_is_half_the_pressure() {
    assert_eq!(queue_pressure_ratio(8, 16), 0.5);
  }

  #[test]
  fn test_an_overfull_queue_is_clamped_rather_than_reported_above_one() {
    assert_eq!(queue_pressure_ratio(100, 16), 1.0);
  }

  #[test]
  fn test_a_queue_with_no_capacity_reports_no_pressure() {
    // Rather than dividing by zero and handing an infinity to the comparisons
    // in `select_frame_action`.
    assert_eq!(queue_pressure_ratio(0, 0), 0.0);
    assert_eq!(queue_pressure_ratio(50, 0), 0.0);
  }

  #[test]
  fn test_pressure_rises_with_the_queue() {
    let mut last = -1.0;
    for len in 0..=20 {
      let value = queue_pressure_ratio(len, 16);
      assert!(value >= last, "{len}");
      last = value;
    }
  }

  #[test]
  fn test_pressure_never_leaves_zero_to_one() {
    for (len, cap) in [(0usize, 1usize), (1, 1), (7, 3), (0, 0), (usize::MAX, 4)] {
      let value = queue_pressure_ratio(len, cap);
      assert!((0.0..=1.0).contains(&value), "{len}/{cap}: {value}");
    }
  }
}

#[cfg(test)]
mod frame_action_scenarios {
  use super::*;

  const LATE: i64 = 100_000;
  const RESYNC: i64 = 1_000_000;

  fn action(drift: i64, len: usize, cap: usize) -> FrameAction {
    select_frame_action(drift, len, cap, LATE, RESYNC)
  }

  #[test]
  fn test_an_on_time_frame_is_used() {
    assert_eq!(action(0, 0, 16), FrameAction::UseCurrent);
  }

  #[test]
  fn test_a_frame_inside_the_late_threshold_is_used() {
    assert_eq!(action(LATE, 0, 16), FrameAction::UseCurrent);
    assert_eq!(action(-LATE, 0, 16), FrameAction::UseCurrent);
  }

  #[test]
  fn test_a_frame_past_the_resync_threshold_resyncs() {
    assert_eq!(action(RESYNC, 0, 16), FrameAction::ResyncWebcam);
    assert_eq!(action(RESYNC + 1, 0, 16), FrameAction::ResyncWebcam);
  }

  #[test]
  fn test_resyncing_does_not_care_which_way_the_drift_went() {
    assert_eq!(action(-RESYNC, 0, 16), FrameAction::ResyncWebcam);
    assert_eq!(action(-RESYNC * 5, 15, 16), FrameAction::ResyncWebcam);
  }

  #[test]
  fn test_resyncing_beats_queue_pressure() {
    // However backed up the queue is, a stream this far out has to be
    // re-anchored rather than papered over frame by frame.
    assert_eq!(action(RESYNC, 16, 16), FrameAction::ResyncWebcam);
  }

  #[test]
  fn test_a_slightly_late_frame_holds_the_last_camera_frame() {
    assert_eq!(action(LATE + 1, 0, 16), FrameAction::UseLastWebcam);
    assert_eq!(action(LATE * 2, 4, 16), FrameAction::UseLastWebcam);
  }

  #[test]
  fn test_a_slightly_late_frame_is_dropped_once_the_queue_backs_up() {
    // Holding the last frame costs nothing to draw but still occupies a slot;
    // at 85% full the cheaper answer is to let the camera skip.
    assert_eq!(action(LATE + 1, 14, 16), FrameAction::DropWebcam);
    assert_eq!(action(LATE + 1, 16, 16), FrameAction::DropWebcam);
  }

  #[test]
  fn test_the_late_drop_threshold_sits_at_eighty_five_percent() {
    assert_eq!(action(LATE + 1, 13, 16), FrameAction::UseLastWebcam);
    assert_eq!(action(LATE + 1, 14, 16), FrameAction::DropWebcam);
  }

  #[test]
  fn test_a_slightly_early_frame_is_used_as_it_is() {
    // Early is the benign direction: the frame exists, it is just ahead.
    assert_eq!(action(-LATE - 1, 0, 16), FrameAction::UseCurrent);
    assert_eq!(action(-LATE * 2, 14, 16), FrameAction::UseCurrent);
  }

  #[test]
  fn test_an_early_frame_is_only_dropped_when_the_queue_is_nearly_full() {
    assert_eq!(action(-LATE - 1, 15, 16), FrameAction::UseCurrent);
    assert_eq!(action(-LATE - 1, 16, 16), FrameAction::DropWebcam);
  }

  #[test]
  fn test_early_frames_tolerate_more_pressure_than_late_ones() {
    let backed_up = 15;
    assert_eq!(action(LATE + 1, backed_up, 16), FrameAction::DropWebcam);
    assert_eq!(action(-LATE - 1, backed_up, 16), FrameAction::UseCurrent);
  }

  #[test]
  fn test_a_zero_late_threshold_is_raised_to_one() {
    // Otherwise every frame would count as late and the camera would never
    // show a live frame again.
    assert_eq!(
      select_frame_action(1, 0, 16, 0, RESYNC),
      FrameAction::UseCurrent
    );
    assert_eq!(
      select_frame_action(2, 0, 16, 0, RESYNC),
      FrameAction::UseLastWebcam
    );
  }

  #[test]
  fn test_a_resync_threshold_below_the_late_one_is_pushed_above_it() {
    // Otherwise the resync branch would swallow the whole late range and the
    // camera would re-anchor on every jitter.
    let a = select_frame_action(LATE, 0, 16, LATE, 0);
    assert_eq!(a, FrameAction::UseCurrent);
    let b = select_frame_action(LATE + 1, 0, 16, LATE, 0);
    assert_eq!(b, FrameAction::ResyncWebcam);
  }

  #[test]
  fn test_a_queue_with_no_capacity_never_forces_a_drop() {
    assert_eq!(action(LATE + 1, 99, 0), FrameAction::UseLastWebcam);
    assert_eq!(action(-LATE - 1, 99, 0), FrameAction::UseCurrent);
  }

  #[test]
  fn test_every_drift_gets_some_answer() {
    for drift in [-5_000_000i64, -999_999, -100_001, -1, 0, 1, 100_001, 999_999, 5_000_000] {
      for len in [0usize, 8, 14, 15, 16] {
        let chosen = action(drift, len, 16);
        assert!(
          matches!(
            chosen,
            FrameAction::UseCurrent
              | FrameAction::UseLastWebcam
              | FrameAction::DropWebcam
              | FrameAction::ResyncWebcam
          ),
          "{drift} {len}"
        );
      }
    }
  }

  #[test]
  fn test_the_decision_only_depends_on_the_size_of_the_drift_for_resync() {
    for magnitude in [RESYNC, RESYNC * 2, i64::MAX / 2] {
      assert_eq!(action(magnitude, 0, 16), action(-magnitude, 0, 16), "{magnitude}");
    }
  }

  #[test]
  fn test_a_miss_streak_at_the_threshold_forces_a_resync() {
    assert!(should_resync_after_misses(5, 5));
    assert!(should_resync_after_misses(9, 5));
  }

  #[test]
  fn test_a_miss_streak_below_the_threshold_does_not() {
    assert!(!should_resync_after_misses(0, 5));
    assert!(!should_resync_after_misses(4, 5));
  }

  #[test]
  fn test_a_zero_miss_threshold_disables_the_streak_resync() {
    // Rather than resyncing on every frame, which is what `>= 0` would do.
    for misses in [0u32, 1, 100, u32::MAX] {
      assert!(!should_resync_after_misses(misses, 0), "{misses}");
    }
  }
}

#[cfg(test)]
mod webcam_pairing_scenarios {
  use super::*;

  #[test]
  fn test_no_camera_ticks_means_no_match() {
    assert_eq!(select_closest_webcam_tick(1000, &[], 500), None);
  }

  #[test]
  fn test_the_nearest_tick_wins() {
    let ticks = [0, 900, 1100, 5000];
    assert_eq!(select_closest_webcam_tick(1000, &ticks, 500), Some(1));
  }

  #[test]
  fn test_a_tick_further_than_the_limit_is_ignored() {
    assert_eq!(select_closest_webcam_tick(1000, &[5000], 500), None);
  }

  #[test]
  fn test_a_tick_exactly_on_the_limit_still_counts() {
    assert_eq!(select_closest_webcam_tick(1000, &[1500], 500), Some(0));
    assert_eq!(select_closest_webcam_tick(1000, &[500], 500), Some(0));
  }

  #[test]
  fn test_a_tie_breaks_to_the_earlier_tick() {
    // Deterministic rather than arrival-order, so two cameras equidistant from
    // a frame do not alternate between them.
    let ticks = [1100, 900];
    assert_eq!(select_closest_webcam_tick(1000, &ticks, 500), Some(1));
  }

  #[test]
  fn test_an_exact_match_wins_outright() {
    let ticks = [999, 1000, 1001];
    assert_eq!(select_closest_webcam_tick(1000, &ticks, 500), Some(1));
  }

  #[test]
  fn test_a_negative_drift_limit_is_treated_as_zero() {
    assert_eq!(select_closest_webcam_tick(1000, &[1000], -50), Some(0));
    assert_eq!(select_closest_webcam_tick(1000, &[1001], -50), None);
  }

  #[test]
  fn test_a_zero_drift_limit_only_accepts_an_exact_match() {
    assert_eq!(select_closest_webcam_tick(1000, &[1000], 0), Some(0));
    assert_eq!(select_closest_webcam_tick(1000, &[999, 1001], 0), None);
  }

  #[test]
  fn test_the_index_points_at_the_tick_it_chose() {
    let ticks = [5000, 300, 1050, 20_000];
    let index = select_closest_webcam_tick(1000, &ticks, 500).unwrap();
    assert_eq!(ticks[index], 1050);
  }

  #[test]
  fn test_matching_works_either_side_of_the_target() {
    assert_eq!(select_closest_webcam_tick(1000, &[800], 500), Some(0));
    assert_eq!(select_closest_webcam_tick(1000, &[1200], 500), Some(0));
  }

  #[test]
  fn test_matching_works_at_negative_ticks() {
    let ticks = [-2000, -1050, -100];
    assert_eq!(select_closest_webcam_tick(-1000, &ticks, 500), Some(1));
  }

  #[test]
  fn test_matching_does_not_overflow_on_extreme_ticks() {
    let ticks = [i64::MIN, i64::MAX, 1000];
    assert_eq!(select_closest_webcam_tick(1000, &ticks, 500), Some(2));
  }

  #[test]
  fn test_a_long_run_of_ticks_still_finds_the_best_one() {
    let ticks: Vec<i64> = (0..200).map(|i| i * 1000).collect();
    let index = select_closest_webcam_tick(107_400, &ticks, 1000).unwrap();
    assert_eq!(ticks[index], 107_000);
  }

  #[test]
  fn test_an_empty_sequence_is_monotonic() {
    assert!(is_monotonic_tick_sequence(&[]));
  }

  #[test]
  fn test_a_single_tick_is_monotonic() {
    assert!(is_monotonic_tick_sequence(&[42]));
  }

  #[test]
  fn test_a_rising_sequence_is_monotonic() {
    assert!(is_monotonic_tick_sequence(&[0, 1, 2, 100, 1000]));
  }

  #[test]
  fn test_repeated_ticks_are_still_monotonic() {
    // Non-decreasing, not strictly increasing: a stalled camera repeats a
    // timestamp, which is not the same as going backwards.
    assert!(is_monotonic_tick_sequence(&[0, 0, 1, 1, 2]));
  }

  #[test]
  fn test_one_step_backwards_breaks_monotonicity() {
    assert!(!is_monotonic_tick_sequence(&[0, 1, 2, 1, 3]));
  }

  #[test]
  fn test_a_regression_at_the_very_end_is_caught() {
    assert!(!is_monotonic_tick_sequence(&[0, 1, 2, 3, 2]));
  }

  #[test]
  fn test_a_regression_at_the_very_start_is_caught() {
    assert!(!is_monotonic_tick_sequence(&[5, 0, 1, 2]));
  }

  #[test]
  fn test_negative_ticks_can_be_monotonic_too() {
    assert!(is_monotonic_tick_sequence(&[-100, -50, 0, 50]));
  }
}

#[cfg(test)]
mod crop_scenarios {
  use super::*;

  #[test]
  fn test_a_matching_aspect_ratio_is_not_cropped() {
    let crop = compute_center_crop_rect(1920, 1080, 1280, 720);
    assert_eq!(
      crop,
      CropRect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080
      }
    );
  }

  #[test]
  fn test_identical_sizes_are_not_cropped() {
    let crop = compute_center_crop_rect(640, 480, 640, 480);
    assert_eq!(crop.width, 640);
    assert_eq!(crop.height, 480);
    assert_eq!((crop.x, crop.y), (0, 0));
  }

  #[test]
  fn test_a_wider_source_loses_its_sides() {
    let crop = compute_center_crop_rect(1920, 1080, 1080, 1080);
    assert_eq!(crop.height, 1080);
    assert_eq!(crop.width, 1080);
    assert_eq!(crop.y, 0);
  }

  #[test]
  fn test_a_wider_source_is_cropped_from_the_middle() {
    let crop = compute_center_crop_rect(1920, 1080, 1080, 1080);
    assert_eq!(crop.x, (1920 - 1080) / 2);
    // Equal margin either side, which is what makes it a centre crop.
    assert_eq!(crop.x, 1920 - crop.x - crop.width);
  }

  #[test]
  fn test_a_taller_source_loses_its_top_and_bottom() {
    let crop = compute_center_crop_rect(1080, 1920, 1920, 1080);
    assert_eq!(crop.width, 1080);
    assert!(crop.height < 1920);
    assert_eq!(crop.x, 0);
  }

  #[test]
  fn test_a_taller_source_is_cropped_from_the_middle() {
    let crop = compute_center_crop_rect(1080, 1920, 1920, 1080);
    assert_eq!(crop.y, (1920 - crop.height) / 2);
  }

  #[test]
  fn test_the_crop_always_fits_inside_the_source() {
    let sizes = [(1920u32, 1080u32), (1080, 1920), (640, 640), (100, 3), (3, 100)];
    let targets = [(1920u32, 1080u32), (1080, 1920), (1, 1), (16, 9)];
    for (sw, sh) in sizes {
      for (dw, dh) in targets {
        let crop = compute_center_crop_rect(sw, sh, dw, dh);
        assert!(crop.x + crop.width <= sw, "{sw}x{sh} -> {dw}x{dh}");
        assert!(crop.y + crop.height <= sh, "{sw}x{sh} -> {dw}x{dh}");
      }
    }
  }

  #[test]
  fn test_the_crop_takes_the_targets_aspect_ratio() {
    let sizes = [(1920u32, 1080u32), (1080, 1920), (640, 640)];
    for (sw, sh) in sizes {
      for (dw, dh) in [(1920u32, 1080u32), (1, 1), (9, 16)] {
        let crop = compute_center_crop_rect(sw, sh, dw, dh);
        let got = crop.width as f64 / crop.height as f64;
        let want = dw as f64 / dh as f64;
        assert!(
          (got - want).abs() / want < 0.01,
          "{sw}x{sh} -> {dw}x{dh}: {got} vs {want}"
        );
      }
    }
  }

  #[test]
  fn test_the_crop_never_has_a_zero_side_for_a_real_source() {
    for (sw, sh) in [(1920u32, 1080u32), (2, 1000), (1000, 2), (1, 1)] {
      let crop = compute_center_crop_rect(sw, sh, 16, 9);
      assert!(crop.width >= 1, "{sw}x{sh}");
      assert!(crop.height >= 1, "{sw}x{sh}");
    }
  }

  #[test]
  fn test_a_source_with_no_pixels_gives_an_empty_crop() {
    let empty = CropRect {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
    assert_eq!(compute_center_crop_rect(0, 1080, 16, 9), empty);
    assert_eq!(compute_center_crop_rect(1920, 0, 16, 9), empty);
  }

  #[test]
  fn test_a_target_with_no_pixels_gives_an_empty_crop() {
    let empty = CropRect {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
    assert_eq!(compute_center_crop_rect(1920, 1080, 0, 9), empty);
    assert_eq!(compute_center_crop_rect(1920, 1080, 16, 0), empty);
  }

  #[test]
  fn test_the_crop_only_depends_on_the_targets_ratio_not_its_size() {
    let a = compute_center_crop_rect(1920, 1080, 1080, 1080);
    let b = compute_center_crop_rect(1920, 1080, 200, 200);
    assert_eq!(a, b);
  }

  #[test]
  fn test_an_extreme_ratio_still_leaves_a_usable_rect() {
    let crop = compute_center_crop_rect(1920, 1080, 10_000, 1);
    assert!(crop.width >= 1 && crop.height >= 1);
    assert!(crop.y + crop.height <= 1080);
  }
}

#[cfg(test)]
mod overlay_rect_scenarios {
  use super::*;

  const W: u32 = 1920;
  const H: u32 = 1080;
  const SIXTEEN_NINE: f32 = 16.0 / 9.0;

  fn rect(anchor: OverlayAnchor) -> OverlayRect {
    compute_overlay_rect(W, H, 0.25, SIXTEEN_NINE, 32, anchor)
  }

  #[test]
  fn test_the_height_follows_the_ratio_of_the_canvas() {
    assert_eq!(rect(OverlayAnchor::TopLeft).height, 270);
  }

  #[test]
  fn test_the_width_follows_the_aspect_ratio_of_the_camera() {
    assert_eq!(rect(OverlayAnchor::TopLeft).width, 480);
  }

  #[test]
  fn test_the_top_left_anchor_sits_at_the_margin() {
    let r = rect(OverlayAnchor::TopLeft);
    assert_eq!((r.x, r.y), (32, 32));
  }

  #[test]
  fn test_the_top_right_anchor_hugs_the_right_edge() {
    let r = rect(OverlayAnchor::TopRight);
    assert_eq!(r.x, W - r.width - 32);
    assert_eq!(r.y, 32);
  }

  #[test]
  fn test_the_bottom_left_anchor_hugs_the_bottom_edge() {
    let r = rect(OverlayAnchor::BottomLeft);
    assert_eq!(r.x, 32);
    assert_eq!(r.y, H - r.height - 32);
  }

  #[test]
  fn test_the_bottom_right_anchor_hugs_both_far_edges() {
    let r = rect(OverlayAnchor::BottomRight);
    assert_eq!(r.x, W - r.width - 32);
    assert_eq!(r.y, H - r.height - 32);
  }

  #[test]
  fn test_every_anchor_produces_the_same_box_in_a_different_corner() {
    let anchors = [
      OverlayAnchor::TopLeft,
      OverlayAnchor::TopRight,
      OverlayAnchor::BottomLeft,
      OverlayAnchor::BottomRight,
    ];
    let first = rect(anchors[0]);
    for anchor in anchors {
      let r = rect(anchor);
      assert_eq!(r.width, first.width, "{anchor:?}");
      assert_eq!(r.height, first.height, "{anchor:?}");
    }
  }

  #[test]
  fn test_the_overlay_always_stays_on_the_canvas() {
    for ratio in [0.0f32, 0.05, 0.5, 0.95, 2.0] {
      for margin in [0u32, 32, 500, 5000] {
        for anchor in [
          OverlayAnchor::TopLeft,
          OverlayAnchor::TopRight,
          OverlayAnchor::BottomLeft,
          OverlayAnchor::BottomRight,
        ] {
          let r = compute_overlay_rect(W, H, ratio, SIXTEEN_NINE, margin, anchor);
          assert!(r.x + r.width <= W, "{ratio} {margin} {anchor:?}");
          assert!(r.y + r.height <= H, "{ratio} {margin} {anchor:?}");
        }
      }
    }
  }

  #[test]
  fn test_a_ratio_below_the_floor_is_raised_to_it() {
    let tiny = compute_overlay_rect(W, H, 0.0, SIXTEEN_NINE, 32, OverlayAnchor::TopLeft);
    let floor = compute_overlay_rect(W, H, 0.05, SIXTEEN_NINE, 32, OverlayAnchor::TopLeft);
    assert_eq!(tiny.height, floor.height);
  }

  #[test]
  fn test_a_ratio_above_the_ceiling_is_lowered_to_it() {
    let huge = compute_overlay_rect(W, H, 5.0, SIXTEEN_NINE, 0, OverlayAnchor::TopLeft);
    let ceiling = compute_overlay_rect(W, H, 0.95, SIXTEEN_NINE, 0, OverlayAnchor::TopLeft);
    assert_eq!(huge.height, ceiling.height);
  }

  #[test]
  fn test_a_bigger_ratio_means_a_bigger_box() {
    let mut last = 0;
    for ratio in [0.05f32, 0.2, 0.4, 0.6, 0.95] {
      let r = compute_overlay_rect(W, H, ratio, SIXTEEN_NINE, 0, OverlayAnchor::TopLeft);
      assert!(r.height >= last, "{ratio}");
      last = r.height;
    }
  }

  #[test]
  fn test_a_non_finite_aspect_ratio_falls_back_to_portrait_nine_sixteen() {
    for bad in [f32::NAN, f32::INFINITY, 0.0, -1.0] {
      let r = compute_overlay_rect(W, H, 0.25, bad, 32, OverlayAnchor::TopLeft);
      let ratio = r.width as f64 / r.height as f64;
      assert!((ratio - 9.0 / 16.0).abs() < 0.02, "{bad}: {ratio}");
    }
  }

  #[test]
  fn test_a_portrait_camera_produces_a_tall_box() {
    let r = compute_overlay_rect(W, H, 0.5, 9.0 / 16.0, 0, OverlayAnchor::TopLeft);
    assert!(r.height > r.width);
  }

  #[test]
  fn test_a_margin_bigger_than_the_canvas_is_clamped() {
    let r = compute_overlay_rect(W, H, 0.25, SIXTEEN_NINE, 100_000, OverlayAnchor::TopLeft);
    assert!(r.x + r.width <= W);
    assert!(r.y + r.height <= H);
    assert!(r.width >= 1 && r.height >= 1);
  }

  #[test]
  fn test_a_zero_margin_puts_the_box_in_the_corner() {
    let r = compute_overlay_rect(W, H, 0.25, SIXTEEN_NINE, 0, OverlayAnchor::TopLeft);
    assert_eq!((r.x, r.y), (0, 0));
    let br = compute_overlay_rect(W, H, 0.25, SIXTEEN_NINE, 0, OverlayAnchor::BottomRight);
    assert_eq!(br.x + br.width, W);
    assert_eq!(br.y + br.height, H);
  }

  #[test]
  fn test_a_box_too_wide_for_the_margins_is_shrunk_to_fit() {
    // A very wide camera at a large ratio: the width has to come down, and the
    // height with it so the picture is not stretched.
    let r = compute_overlay_rect(400, 400, 0.95, 10.0, 20, OverlayAnchor::TopLeft);
    assert!(r.width <= 400 - 40);
    let ratio = r.width as f64 / r.height as f64;
    assert!((ratio - 10.0).abs() < 1.0, "{ratio}");
  }

  #[test]
  fn test_a_box_too_tall_for_the_margins_is_shrunk_to_fit() {
    let r = compute_overlay_rect(400, 400, 0.95, 0.1, 20, OverlayAnchor::TopLeft);
    assert!(r.height <= 400 - 40);
  }

  #[test]
  fn test_a_canvas_with_no_pixels_gives_an_empty_overlay() {
    let empty = OverlayRect {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
    assert_eq!(
      compute_overlay_rect(0, 1080, 0.25, SIXTEEN_NINE, 32, OverlayAnchor::TopLeft),
      empty
    );
    assert_eq!(
      compute_overlay_rect(1920, 0, 0.25, SIXTEEN_NINE, 32, OverlayAnchor::TopLeft),
      empty
    );
  }

  #[test]
  fn test_a_one_pixel_canvas_still_gets_a_one_pixel_overlay() {
    let r = compute_overlay_rect(1, 1, 0.25, SIXTEEN_NINE, 0, OverlayAnchor::TopLeft);
    assert_eq!((r.width, r.height), (1, 1));
    assert_eq!((r.x, r.y), (0, 0));
  }

  #[test]
  fn test_the_overlay_never_has_a_zero_side() {
    for (w, h) in [(1u32, 1u32), (10, 10), (1920, 1080), (100, 4000)] {
      for ratio in [0.05f32, 0.5, 0.95] {
        let r = compute_overlay_rect(w, h, ratio, SIXTEEN_NINE, 4, OverlayAnchor::BottomRight);
        assert!(r.width >= 1, "{w}x{h} {ratio}");
        assert!(r.height >= 1, "{w}x{h} {ratio}");
      }
    }
  }

  #[test]
  fn test_a_portrait_canvas_is_handled_as_well_as_a_landscape_one() {
    let r = compute_overlay_rect(1080, 1920, 0.25, SIXTEEN_NINE, 32, OverlayAnchor::BottomRight);
    assert!(r.x + r.width <= 1080);
    assert!(r.y + r.height <= 1920);
    assert_eq!(r.height, 480);
  }
}

#[cfg(test)]
mod drop_stats_scenarios {
  use super::*;

  #[test]
  fn test_no_frames_at_all_is_no_drops() {
    // Rather than dividing by zero and reporting NaN in the stats panel.
    assert_eq!(compute_frame_drop_stats(0, 0), 0.0);
    assert_eq!(compute_frame_drop_stats(0, 5), 0.0);
  }

  #[test]
  fn test_dropping_nothing_is_zero_percent() {
    assert_eq!(compute_frame_drop_stats(1000, 0), 0.0);
  }

  #[test]
  fn test_dropping_everything_is_a_hundred_percent() {
    assert_eq!(compute_frame_drop_stats(1000, 1000), 100.0);
  }

  #[test]
  fn test_dropping_a_tenth_is_ten_percent() {
    assert_eq!(compute_frame_drop_stats(1000, 100), 10.0);
  }

  #[test]
  fn test_dropping_more_than_everything_is_clamped() {
    // Which can happen when the counters are read a moment apart.
    assert_eq!(compute_frame_drop_stats(100, 500), 100.0);
  }

  #[test]
  fn test_the_percentage_never_leaves_zero_to_a_hundred() {
    for (total, dropped) in [
      (1u64, 0u64),
      (1, 1),
      (60, 7),
      (u64::MAX, 1),
      (1, u64::MAX),
      (100_000, 99_999),
    ] {
      let value = compute_frame_drop_stats(total, dropped);
      assert!((0.0..=100.0).contains(&value), "{total}/{dropped}: {value}");
    }
  }

  #[test]
  fn test_the_percentage_rises_with_the_drop_count() {
    let mut last = -1.0;
    for dropped in [0u64, 1, 10, 50, 99, 100] {
      let value = compute_frame_drop_stats(100, dropped);
      assert!(value >= last, "{dropped}");
      last = value;
    }
  }

  #[test]
  fn test_one_frame_in_sixty_is_a_bit_under_two_percent() {
    let value = compute_frame_drop_stats(60, 1);
    assert!((value - 1.6667).abs() < 0.001, "{value}");
  }
}
