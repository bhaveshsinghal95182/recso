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
  let lower = raw_tick_100ns.div_euclid(period) * period;
  let upper = lower.saturating_add(period);

  let distance_to_lower = raw_tick_100ns.saturating_sub(lower).abs();
  let distance_to_upper = upper.saturating_sub(raw_tick_100ns).abs();

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
  let mut next_carry = expected_with_fraction - expected_bytes as f64;

  if expected_bytes < safe_block_align {
    expected_bytes = safe_block_align;
    next_carry = 0.0;
  }

  expected_bytes -= expected_bytes % safe_block_align;

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
  let abs_drift = drift_100ns.abs();

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
    let abs_drift = tick.saturating_sub(target_tick_100ns).abs();
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
