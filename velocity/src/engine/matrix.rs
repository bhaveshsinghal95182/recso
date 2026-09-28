//! Combination matrices.
//!
//! The per-module tests pin specific values. These sweep the cross-product of
//! the inputs each function actually sees and assert the properties that must
//! hold in *every* cell -- no distortion, nothing off the canvas, nothing
//! non-finite, monotonic where it claims to be.
//!
//! The point is coverage of the input space rather than of the line count: a
//! rounding branch that only misbehaves for tall sources at small box sizes is
//! not something a hand-picked example finds.

use crate::engine::layout::{
  fit_source, smear_geometry, CursorSample, CursorTrack, FitMode, HiddenSpans, OverlayShape, Rect,
  Shadow, UvRect, WebcamLayout,
};
use crate::engine::cuts::{Cut, CutTrack};
use crate::engine::scene::{parse_layer_order, Layer, SourceCrop, VideoLayout};
use crate::engine::zoom::{
  lerp_rect, FocalKeyframe, WebcamZoomRegion, WebcamZoomTrack, ZoomRegion, ZoomState, ZoomTrack,
};

// -- shared sweeps -----------------------------------------------------------

/// Box shapes a layout realistically produces: wide, square, tall, tiny, huge.
const BOXES: [(f32, f32); 8] = [
  (1920.0, 1080.0),
  (1280.0, 720.0),
  (400.0, 400.0),
  (300.0, 600.0),
  (1080.0, 1920.0),
  (16.0, 9.0),
  (1.0, 1.0),
  (3000.0, 100.0),
];

/// Source resolutions a camera or a recording realistically reports.
const SOURCES: [(u32, u32); 10] = [
  (1920, 1080),
  (1280, 720),
  (640, 480),
  (1080, 1920),
  (720, 1280),
  (3840, 2160),
  (1, 1),
  (4000, 3),
  (3, 4000),
  (2560, 1080),
];

const FITS: [FitMode; 3] = [FitMode::Cover, FitMode::Contain, FitMode::Stretch];

fn boxed(w: f32, h: f32) -> Rect {
  Rect {
    x: 37.0,
    y: 53.0,
    width: w,
    height: h,
  }
}

fn aspect(w: f32, h: f32) -> f32 {
  w / h
}

// -- fitting -----------------------------------------------------------------

mod fit_matrix {
  use super::*;

  #[test]
  fn every_cell_produces_a_finite_rect_and_uv() {
    for (bw, bh) in BOXES {
      for (sw, sh) in SOURCES {
        for fit in FITS {
          let (rect, uv) = fit_source(boxed(bw, bh), sw, sh, fit);
          let label = format!("{bw}x{bh} <- {sw}x{sh} {fit:?}");
          assert!(rect.x.is_finite() && rect.y.is_finite(), "{label}");
          assert!(rect.width.is_finite() && rect.height.is_finite(), "{label}");
          assert!(uv.scale.iter().all(|v| v.is_finite()), "{label}");
          assert!(uv.offset.iter().all(|v| v.is_finite()), "{label}");
        }
      }
    }
  }

  #[test]
  fn cover_never_moves_or_resizes_the_box_in_any_cell() {
    // The whole reason cover works through uvs: the shape mask is evaluated
    // against the quad, so growing it would clip a circular camera.
    for (bw, bh) in BOXES {
      for (sw, sh) in SOURCES {
        let (rect, _) = fit_source(boxed(bw, bh), sw, sh, FitMode::Cover);
        assert_eq!(rect, boxed(bw, bh), "{bw}x{bh} <- {sw}x{sh}");
      }
    }
  }

  #[test]
  fn stretch_never_touches_anything_in_any_cell() {
    for (bw, bh) in BOXES {
      for (sw, sh) in SOURCES {
        let (rect, uv) = fit_source(boxed(bw, bh), sw, sh, FitMode::Stretch);
        assert_eq!(rect, boxed(bw, bh), "{bw}x{bh} <- {sw}x{sh}");
        assert_eq!(uv, UvRect::default(), "{bw}x{bh} <- {sw}x{sh}");
      }
    }
  }

  #[test]
  fn cover_never_reads_outside_the_source_in_any_cell() {
    for (bw, bh) in BOXES {
      for (sw, sh) in SOURCES {
        let (_, uv) = fit_source(boxed(bw, bh), sw, sh, FitMode::Cover);
        let label = format!("{bw}x{bh} <- {sw}x{sh}");
        for axis in 0..2 {
          assert!(uv.scale[axis] <= 1.0 + 1e-4, "{label} scale {axis}");
          assert!(uv.scale[axis] > 0.0, "{label} scale {axis}");
          assert!(uv.offset[axis] >= -1e-4, "{label} offset {axis}");
          assert!(
            uv.offset[axis] + uv.scale[axis] <= 1.0 + 1e-4,
            "{label} span {axis}"
          );
        }
      }
    }
  }

  #[test]
  fn cover_crops_from_the_middle_in_any_cell() {
    for (bw, bh) in BOXES {
      for (sw, sh) in SOURCES {
        let (_, uv) = fit_source(boxed(bw, bh), sw, sh, FitMode::Cover);
        for axis in 0..2 {
          let before = uv.offset[axis];
          let after = 1.0 - (uv.offset[axis] + uv.scale[axis]);
          assert!(
            (before - after).abs() < 1e-3,
            "{bw}x{bh} <- {sw}x{sh} axis {axis}: {before} vs {after}"
          );
        }
      }
    }
  }

  #[test]
  fn cover_leaves_the_visible_pixels_undistorted_in_any_cell() {
    for (bw, bh) in BOXES {
      for (sw, sh) in SOURCES {
        let (rect, uv) = fit_source(boxed(bw, bh), sw, sh, FitMode::Cover);
        let read_w = sw as f32 * uv.scale[0];
        let read_h = sh as f32 * uv.scale[1];
        let distortion = aspect(rect.width, rect.height) / aspect(read_w, read_h);
        assert!(
          (distortion - 1.0).abs() < 0.02,
          "{bw}x{bh} <- {sw}x{sh}: {distortion}"
        );
      }
    }
  }

  #[test]
  fn contain_never_crops_in_any_cell() {
    for (bw, bh) in BOXES {
      for (sw, sh) in SOURCES {
        let (_, uv) = fit_source(boxed(bw, bh), sw, sh, FitMode::Contain);
        assert_eq!(uv, UvRect::default(), "{bw}x{bh} <- {sw}x{sh}");
      }
    }
  }

  #[test]
  fn contain_never_grows_the_box_in_any_cell() {
    for (bw, bh) in BOXES {
      for (sw, sh) in SOURCES {
        let (rect, _) = fit_source(boxed(bw, bh), sw, sh, FitMode::Contain);
        assert!(rect.width <= bw + 1e-2, "{bw}x{bh} <- {sw}x{sh}");
        assert!(rect.height <= bh + 1e-2, "{bw}x{bh} <- {sw}x{sh}");
      }
    }
  }

  #[test]
  fn contain_stays_inside_the_box_in_any_cell() {
    for (bw, bh) in BOXES {
      for (sw, sh) in SOURCES {
        let outer = boxed(bw, bh);
        let (rect, _) = fit_source(outer, sw, sh, FitMode::Contain);
        let label = format!("{bw}x{bh} <- {sw}x{sh}");
        assert!(rect.x >= outer.x - 1e-2, "{label}");
        assert!(rect.y >= outer.y - 1e-2, "{label}");
        assert!(
          rect.x + rect.width <= outer.x + outer.width + 1e-2,
          "{label}"
        );
        assert!(
          rect.y + rect.height <= outer.y + outer.height + 1e-2,
          "{label}"
        );
      }
    }
  }

  #[test]
  fn contain_centres_what_it_shrank_in_any_cell() {
    for (bw, bh) in BOXES {
      for (sw, sh) in SOURCES {
        let outer = boxed(bw, bh);
        let (rect, _) = fit_source(outer, sw, sh, FitMode::Contain);
        let left = rect.x - outer.x;
        let right = (outer.x + outer.width) - (rect.x + rect.width);
        let top = rect.y - outer.y;
        let bottom = (outer.y + outer.height) - (rect.y + rect.height);
        let label = format!("{bw}x{bh} <- {sw}x{sh}");
        assert!((left - right).abs() < 1e-2, "{label} h: {left} vs {right}");
        assert!((top - bottom).abs() < 1e-2, "{label} v: {top} vs {bottom}");
      }
    }
  }

  #[test]
  fn contain_takes_the_sources_aspect_ratio_in_any_cell() {
    for (bw, bh) in BOXES {
      for (sw, sh) in SOURCES {
        let (rect, _) = fit_source(boxed(bw, bh), sw, sh, FitMode::Contain);
        if rect.width < 1.0 || rect.height < 1.0 {
          // Sub-pixel results are dominated by rounding; the finiteness sweep
          // already covers them.
          continue;
        }
        let got = aspect(rect.width, rect.height);
        let want = aspect(sw as f32, sh as f32);
        assert!(
          (got / want - 1.0).abs() < 0.05,
          "{bw}x{bh} <- {sw}x{sh}: {got} vs {want}"
        );
      }
    }
  }

  #[test]
  fn a_matching_aspect_ratio_collapses_every_mode_to_the_same_answer() {
    // Cover and contain only differ when the ratios do.
    let pairs = [
      ((1920.0f32, 1080.0f32), (1920u32, 1080u32)),
      ((1920.0, 1080.0), (1280, 720)),
      ((400.0, 400.0), (1, 1)),
      ((1080.0, 1920.0), (720, 1280)),
    ];
    for ((bw, bh), (sw, sh)) in pairs {
      let cover = fit_source(boxed(bw, bh), sw, sh, FitMode::Cover);
      let contain = fit_source(boxed(bw, bh), sw, sh, FitMode::Contain);
      let stretch = fit_source(boxed(bw, bh), sw, sh, FitMode::Stretch);
      assert_eq!(cover, contain, "{bw}x{bh} <- {sw}x{sh}");
      assert_eq!(cover, stretch, "{bw}x{bh} <- {sw}x{sh}");
    }
  }

  #[test]
  fn contain_is_idempotent_across_the_matrix() {
    // Feeding contain's own result back has nothing left to do; a second
    // shrink would mean the first was wrong.
    for (bw, bh) in BOXES {
      for (sw, sh) in SOURCES {
        let (once, _) = fit_source(boxed(bw, bh), sw, sh, FitMode::Contain);
        if once.width < 1.0 || once.height < 1.0 {
          continue;
        }
        let (twice, _) = fit_source(once, sw, sh, FitMode::Contain);
        let label = format!("{bw}x{bh} <- {sw}x{sh}");
        assert!(
          (once.width - twice.width).abs() < once.width * 0.05,
          "{label}"
        );
        assert!(
          (once.height - twice.height).abs() < once.height * 0.05,
          "{label}"
        );
      }
    }
  }

  #[test]
  fn an_empty_box_is_untouched_by_every_mode_and_source() {
    for (sw, sh) in SOURCES {
      for fit in FITS {
        for empty in [boxed(0.0, 100.0), boxed(100.0, 0.0), boxed(0.0, 0.0)] {
          let (rect, uv) = fit_source(empty, sw, sh, fit);
          assert_eq!(rect, empty, "{sw}x{sh} {fit:?}");
          assert_eq!(uv, UvRect::default(), "{sw}x{sh} {fit:?}");
        }
      }
    }
  }

  #[test]
  fn a_source_with_no_pixels_is_survivable_in_every_cell() {
    for (bw, bh) in BOXES {
      for fit in FITS {
        let (rect, uv) = fit_source(boxed(bw, bh), 0, 0, fit);
        assert!(
          rect.width.is_finite() && rect.height.is_finite(),
          "{bw}x{bh} {fit:?}"
        );
        assert!(uv.scale.iter().all(|v| v.is_finite()), "{bw}x{bh} {fit:?}");
      }
    }
  }

  #[test]
  fn a_nan_box_never_produces_a_crop_in_any_cell() {
    // NaN makes the aspect ratio non-finite, which short-circuits to reading
    // the whole source.
    let bad = [
      Rect {
        x: 0.0,
        y: 0.0,
        width: f32::NAN,
        height: 100.0,
      },
      Rect {
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: f32::NAN,
      },
    ];
    for rect in bad {
      for (sw, sh) in SOURCES {
        for fit in [FitMode::Cover, FitMode::Contain] {
          let (_, uv) = fit_source(rect, sw, sh, fit);
          assert_eq!(uv, UvRect::default(), "{rect:?} {sw}x{sh} {fit:?}");
        }
      }
    }
  }

  #[test]
  fn an_infinite_box_degenerates_rather_than_going_non_finite() {
    // Infinity is the case NaN's short-circuit does not cover: the ratio comes
    // out as a finite 0, so cover takes its normal branch and reads a
    // zero-height strip. Degenerate, but not a NaN handed to the shader.
    let rect = Rect {
      x: 0.0,
      y: 0.0,
      width: f32::INFINITY,
      height: 100.0,
    };
    let (_, uv) = fit_source(rect, 1920, 1080, FitMode::Cover);
    assert!(uv.scale.iter().all(|v| v.is_finite()), "{:?}", uv.scale);
    assert!(uv.offset.iter().all(|v| v.is_finite()), "{:?}", uv.offset);
    assert_eq!(uv.scale[1], 0.0);
  }

  #[test]
  fn the_sanitizers_are_what_stop_an_infinite_box_ever_reaching_the_fit() {
    // So the degenerate case above is unreachable in the chain: both layouts
    // flatten a non-finite size to nothing on the way in, and an empty box is
    // returned untouched by `fit_source`.
    let layout = WebcamLayout {
      rect: Rect {
        x: 0.0,
        y: 0.0,
        width: f32::INFINITY,
        height: 100.0,
      },
      ..Default::default()
    }
    .sanitized();
    assert_eq!(layout.rect.width, 0.0);
    assert_eq!(layout.rect.height, 0.0);

    let (rect, uv) = fit_source(layout.rect, 1920, 1080, FitMode::Cover);
    assert!(rect.is_empty());
    assert_eq!(uv, UvRect::default());
  }
}

// -- zooming -----------------------------------------------------------------

mod zoom_matrix {
  use super::*;

  const LEVELS: [f32; 6] = [1.0, 1.25, 1.5, 2.0, 3.0, 4.0];
  const EASES: [f64; 5] = [0.0, 50.0, 200.0, 400.0, 1_000.0];
  const SPANS: [(f64, f64); 4] = [
    (1_000.0, 3_000.0),
    (0.0, 500.0),
    (5_000.0, 5_100.0),
    (0.0, 60_000.0),
  ];

  fn region(span: (f64, f64), level: f32, ease: f64) -> ZoomRegion {
    ZoomRegion {
      start_ms: span.0,
      end_ms: span.1,
      level,
      focal_x: 0.5,
      focal_y: 0.5,
      ease_duration_ms: ease,
      focal_keyframes: Vec::new(),
    }
  }

  fn video() -> Rect {
    boxed(1728.0, 972.0)
  }

  /// Twenty samples across a region plus a little either side.
  fn sweep(span: (f64, f64)) -> Vec<f64> {
    let pad = (span.1 - span.0).max(1.0) * 0.1;
    (0..=20)
      .map(|i| span.0 - pad + (span.1 - span.0 + pad * 2.0) * (i as f64 / 20.0))
      .collect()
  }

  #[test]
  fn the_scale_stays_between_one_and_the_level_in_every_cell() {
    for span in SPANS {
      for level in LEVELS {
        for ease in EASES {
          let track = ZoomTrack::new(vec![region(span, level, ease)]);
          for at in sweep(span) {
            let scale = track.state_at(at, video()).scale;
            let label = format!("{span:?} level {level} ease {ease} at {at}");
            assert!(scale.is_finite(), "{label}");
            assert!(scale >= 1.0 - 1e-5, "{label}: {scale}");
            assert!(scale <= level.max(1.0) + 1e-5, "{label}: {scale}");
          }
        }
      }
    }
  }

  #[test]
  fn outside_the_span_there_is_never_a_zoom_in_any_cell() {
    for span in SPANS {
      for level in LEVELS {
        for ease in EASES {
          let track = ZoomTrack::new(vec![region(span, level, ease)]);
          for at in [
            span.0 - 1.0,
            span.1 + 1.0,
            span.0 - 10_000.0,
            span.1 + 10_000.0,
          ] {
            assert!(
              track.state_at(at, video()).is_identity(),
              "{span:?} level {level} ease {ease} at {at}"
            );
          }
        }
      }
    }
  }

  #[test]
  fn the_pivot_is_always_inside_the_video_in_every_cell() {
    for span in SPANS {
      for focal in [(0.0f32, 0.0f32), (0.5, 0.5), (1.0, 1.0), (0.25, 0.75)] {
        let mut r = region(span, 2.0, 200.0);
        r.focal_x = focal.0;
        r.focal_y = focal.1;
        let track = ZoomTrack::new(vec![r]);
        for at in sweep(span) {
          let state = track.state_at(at, video());
          let label = format!("{span:?} focal {focal:?} at {at}");
          assert!(state.pivot_x >= video().x - 1e-3, "{label}");
          assert!(state.pivot_x <= video().x + video().width + 1e-3, "{label}");
          assert!(state.pivot_y >= video().y - 1e-3, "{label}");
          assert!(
            state.pivot_y <= video().y + video().height + 1e-3,
            "{label}"
          );
        }
      }
    }
  }

  #[test]
  fn a_zoom_of_one_is_the_identity_at_every_ease_and_span() {
    for span in SPANS {
      for ease in EASES {
        let track = ZoomTrack::new(vec![region(span, 1.0, ease)]);
        for at in sweep(span) {
          assert!(
            track.state_at(at, video()).is_identity(),
            "{span:?} ease {ease} at {at}"
          );
        }
      }
    }
  }

  #[test]
  fn a_zero_ease_holds_the_full_level_across_the_whole_span() {
    for span in SPANS {
      for level in LEVELS {
        let track = ZoomTrack::new(vec![region(span, level, 0.0)]);
        for at in [span.0, (span.0 + span.1) * 0.5, span.1] {
          let scale = track.state_at(at, video()).scale;
          assert!(
            (scale - level).abs() < 1e-4,
            "{span:?} level {level} at {at}: {scale}"
          );
        }
      }
    }
  }

  #[test]
  fn an_ease_shorter_than_half_the_span_reaches_the_full_level() {
    for span in SPANS {
      let half = (span.1 - span.0) * 0.5;
      for level in LEVELS {
        for ease in EASES.iter().filter(|e| **e < half) {
          let track = ZoomTrack::new(vec![region(span, level, *ease)]);
          let middle = (span.0 + span.1) * 0.5;
          let scale = track.state_at(middle, video()).scale;
          assert!(
            (scale - level).abs() < 1e-4,
            "{span:?} level {level} ease {ease}: {scale}"
          );
        }
      }
    }
  }

  #[test]
  fn an_eased_zoom_starts_and_ends_at_no_zoom_when_it_has_room() {
    for span in SPANS {
      let half = (span.1 - span.0) * 0.5;
      for ease in EASES.iter().filter(|e| **e > 0.0 && **e < half) {
        let track = ZoomTrack::new(vec![region(span, 3.0, *ease)]);
        let start = track.state_at(span.0, video()).scale;
        let end = track.state_at(span.1, video()).scale;
        assert!((start - 1.0).abs() < 1e-4, "{span:?} ease {ease}: {start}");
        assert!((end - 1.0).abs() < 1e-4, "{span:?} ease {ease}: {end}");
      }
    }
  }

  #[test]
  fn the_ease_in_is_monotonic_in_every_cell() {
    for span in SPANS {
      let half = (span.1 - span.0) * 0.5;
      for level in LEVELS {
        for ease in EASES.iter().filter(|e| **e > 0.0 && **e < half) {
          let track = ZoomTrack::new(vec![region(span, level, *ease)]);
          let mut last = 0.0;
          for i in 0..=10 {
            let at = span.0 + ease * (i as f64 / 10.0);
            let scale = track.state_at(at, video()).scale;
            assert!(
              scale >= last - 1e-5,
              "{span:?} level {level} ease {ease} step {i}: {scale} < {last}"
            );
            last = scale;
          }
        }
      }
    }
  }

  #[test]
  fn the_ease_out_is_monotonic_in_every_cell() {
    for span in SPANS {
      let half = (span.1 - span.0) * 0.5;
      for level in LEVELS {
        for ease in EASES.iter().filter(|e| **e > 0.0 && **e < half) {
          let track = ZoomTrack::new(vec![region(span, level, *ease)]);
          let mut last = f32::INFINITY;
          for i in 0..=10 {
            let at = span.1 - ease + ease * (i as f64 / 10.0);
            let scale = track.state_at(at, video()).scale;
            assert!(
              scale <= last + 1e-5,
              "{span:?} level {level} ease {ease} step {i}: {scale} > {last}"
            );
            last = scale;
          }
        }
      }
    }
  }

  #[test]
  fn applying_a_state_scales_the_rect_by_exactly_its_scale_in_every_cell() {
    for span in SPANS {
      for level in LEVELS {
        for ease in EASES {
          let track = ZoomTrack::new(vec![region(span, level, ease)]);
          for at in sweep(span) {
            let state = track.state_at(at, video());
            let out = state.apply(video());
            let label = format!("{span:?} {level} {ease} at {at}");
            if state.is_identity() {
              assert_eq!(out, video(), "{label}");
            } else {
              assert!(
                (out.width - video().width * state.scale).abs() < 1e-2,
                "{label}"
              );
            }
          }
        }
      }
    }
  }

  #[test]
  fn the_pivot_is_a_fixed_point_of_the_transform_in_every_cell() {
    for scale in [0.25f32, 0.5, 1.0, 1.5, 2.0, 4.0, 10.0] {
      for pivot in [
        (0.0f32, 0.0f32),
        (960.0, 540.0),
        (1920.0, 1080.0),
        (-100.0, 50.0),
      ] {
        let state = ZoomState {
          scale,
          pivot_x: pivot.0,
          pivot_y: pivot.1,
        };
        let out = state.apply(video());
        let label = format!("scale {scale} pivot {pivot:?}");
        if state.is_identity() {
          assert_eq!(out, video(), "{label}");
          continue;
        }
        // The pivot sits at the same fraction of the rect before and after.
        let before = (pivot.0 - video().x) / video().width;
        let after = (pivot.0 - out.x) / out.width;
        assert!(
          (before - after).abs() < 1e-3,
          "{label}: {before} vs {after}"
        );
      }
    }
  }

  #[test]
  fn scaling_and_unscaling_about_the_same_pivot_round_trips_in_every_cell() {
    for scale in [0.5f32, 1.5, 2.0, 4.0] {
      for pivot in [(0.0f32, 0.0f32), (960.0, 540.0), (1920.0, 1080.0)] {
        let up = ZoomState {
          scale,
          pivot_x: pivot.0,
          pivot_y: pivot.1,
        };
        let down = ZoomState {
          scale: 1.0 / scale,
          pivot_x: pivot.0,
          pivot_y: pivot.1,
        };
        let back = down.apply(up.apply(video()));
        let label = format!("scale {scale} pivot {pivot:?}");
        assert!((back.x - video().x).abs() < 1e-2, "{label}");
        assert!((back.width - video().width).abs() < 1e-2, "{label}");
      }
    }
  }

  #[test]
  fn overlapping_regions_always_resolve_to_the_earliest_start() {
    for level_a in LEVELS {
      for level_b in LEVELS {
        let track = ZoomTrack::new(vec![
          region((2_000.0, 4_000.0), level_b, 0.0),
          region((1_000.0, 5_000.0), level_a, 0.0),
        ]);
        let scale = track.state_at(3_000.0, video()).scale;
        assert!(
          (scale - level_a).abs() < 1e-4,
          "{level_a} vs {level_b}: {scale}"
        );
      }
    }
  }

  #[test]
  fn a_run_of_back_to_back_regions_never_leaves_a_non_finite_frame() {
    let regions: Vec<ZoomRegion> = (0..12)
      .map(|i| {
        region(
          (i as f64 * 1_000.0, i as f64 * 1_000.0 + 1_000.0),
          1.0 + i as f32 * 0.25,
          200.0,
        )
      })
      .collect();
    let track = ZoomTrack::new(regions);
    for step in 0..600 {
      let at = step as f64 * 25.0;
      let state = track.state_at(at, video());
      assert!(state.scale.is_finite(), "{at}");
      assert!(
        state.pivot_x.is_finite() && state.pivot_y.is_finite(),
        "{at}"
      );
      assert!(state.apply(video()).width.is_finite(), "{at}");
    }
  }

  #[test]
  fn a_pan_never_leaves_the_recording_for_any_keyframe_set() {
    let corners = [
      (0.0f32, 0.0f32),
      (1.0, 0.0),
      (1.0, 1.0),
      (0.0, 1.0),
      (0.5, 0.5),
    ];
    for a in corners {
      for b in corners {
        let mut r = region((1_000.0, 3_000.0), 2.0, 0.0);
        r.focal_x = a.0;
        r.focal_y = a.1;
        r.focal_keyframes = vec![FocalKeyframe {
          timestamp_ms: 3_000.0,
          x: b.0,
          y: b.1,
        }];
        let track = ZoomTrack::new(vec![r]);
        for step in 0..=20 {
          let at = 1_000.0 + 100.0 * step as f64;
          let state = track.state_at(at, video());
          let label = format!("{a:?} -> {b:?} at {at}");
          assert!(state.pivot_x >= video().x - 1e-3, "{label}");
          assert!(state.pivot_x <= video().x + video().width + 1e-3, "{label}");
          assert!(state.pivot_y >= video().y - 1e-3, "{label}");
          assert!(
            state.pivot_y <= video().y + video().height + 1e-3,
            "{label}"
          );
        }
      }
    }
  }

  #[test]
  fn a_pan_is_monotonic_between_two_keyframes_for_every_pair() {
    let points = [0.0f32, 0.25, 0.5, 0.75, 1.0];
    for a in points {
      for b in points {
        let mut r = region((1_000.0, 3_000.0), 2.0, 0.0);
        r.focal_x = a;
        r.focal_keyframes = vec![FocalKeyframe {
          timestamp_ms: 3_000.0,
          x: b,
          y: 0.5,
        }];
        let track = ZoomTrack::new(vec![r]);
        let mut last = track.state_at(1_000.0, video()).pivot_x;
        let rising = b >= a;
        for step in 1..=20 {
          let at = 1_000.0 + 100.0 * step as f64;
          let now = track.state_at(at, video()).pivot_x;
          let label = format!("{a} -> {b} step {step}");
          if rising {
            assert!(now >= last - 1e-3, "{label}");
          } else {
            assert!(now <= last + 1e-3, "{label}");
          }
          last = now;
        }
      }
    }
  }
}

// -- webcam zoom -------------------------------------------------------------

mod webcam_zoom_matrix {
  use super::*;

  const BASE: Rect = Rect {
    x: 1440.0,
    y: 780.0,
    width: 384.0,
    height: 216.0,
  };

  fn target(w: f32, h: f32) -> Rect {
    Rect {
      x: 0.0,
      y: 0.0,
      width: w,
      height: h,
    }
  }

  fn region(span: (f64, f64), ease: f64, rect: Rect, full: bool) -> WebcamZoomRegion {
    WebcamZoomRegion {
      start_ms: span.0,
      end_ms: span.1,
      ease_duration_ms: ease,
      rect,
      full_screen: full,
    }
  }

  #[test]
  fn the_box_is_always_between_the_two_it_eases_between_in_every_cell() {
    for ease in [0.0f64, 100.0, 400.0, 5_000.0] {
      for full in [false, true] {
        for (w, h) in [(1920.0f32, 1080.0f32), (800.0, 450.0), (100.0, 100.0)] {
          let grown = target(w, h);
          let track = WebcamZoomTrack::new(vec![region((1_000.0, 3_000.0), ease, grown, full)]);
          for step in 0..=40 {
            let at = 900.0 + 55.0 * step as f64;
            let rect = track.state_at(at, BASE).rect;
            let label = format!("ease {ease} full {full} {w}x{h} at {at}");
            let lo = BASE.width.min(grown.width) - 1e-2;
            let hi = BASE.width.max(grown.width) + 1e-2;
            assert!(
              rect.width >= lo && rect.width <= hi,
              "{label}: {}",
              rect.width
            );
            assert!(rect.width.is_finite() && rect.height.is_finite(), "{label}");
          }
        }
      }
    }
  }

  #[test]
  fn full_screen_progress_stays_in_range_in_every_cell() {
    for ease in [0.0f64, 100.0, 400.0, 5_000.0] {
      for full in [false, true] {
        let track = WebcamZoomTrack::new(vec![region(
          (1_000.0, 3_000.0),
          ease,
          target(1920.0, 1080.0),
          full,
        )]);
        for step in 0..=40 {
          let at = 900.0 + 55.0 * step as f64;
          let value = track.state_at(at, BASE).full_screen;
          let label = format!("ease {ease} full {full} at {at}");
          assert!((0.0..=1.0).contains(&value), "{label}: {value}");
          if !full {
            assert_eq!(value, 0.0, "{label}");
          }
        }
      }
    }
  }

  #[test]
  fn outside_every_region_the_camera_is_where_it_was_laid_out_in_every_cell() {
    for ease in [0.0f64, 100.0, 400.0] {
      for full in [false, true] {
        let track = WebcamZoomTrack::new(vec![region(
          (1_000.0, 3_000.0),
          ease,
          target(1920.0, 1080.0),
          full,
        )]);
        for at in [0.0, 999.9, 3_000.1, 100_000.0] {
          let state = track.state_at(at, BASE);
          assert_eq!(state.rect, BASE, "ease {ease} full {full} at {at}");
          assert_eq!(state.full_screen, 0.0, "ease {ease} full {full} at {at}");
        }
      }
    }
  }

  #[test]
  fn the_size_and_the_dissolve_move_together_for_every_ease() {
    // The radius and border fade over the same curve the box grows on, so the
    // camera does not pop square at the end of the move.
    for ease in [100.0f64, 200.0, 400.0] {
      let grown = target(1920.0, 1080.0);
      let track = WebcamZoomTrack::new(vec![region((1_000.0, 3_000.0), ease, grown, true)]);
      for step in 0..=10 {
        let at = 1_000.0 + ease * (step as f64 / 10.0);
        let state = track.state_at(at, BASE);
        let expected = lerp_rect(BASE, grown, state.full_screen);
        assert!(
          (state.rect.width - expected.width).abs() < 1e-2,
          "ease {ease} step {step}"
        );
      }
    }
  }

  #[test]
  fn the_camera_returns_to_whatever_layout_it_currently_has_in_every_cell() {
    let layouts = [
      BASE,
      Rect {
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 100.0,
      },
      Rect {
        x: 500.0,
        y: 500.0,
        width: 800.0,
        height: 450.0,
      },
    ];
    for layout in layouts {
      let track = WebcamZoomTrack::new(vec![region(
        (1_000.0, 3_000.0),
        200.0,
        target(1920.0, 1080.0),
        true,
      )]);
      assert_eq!(track.state_at(0.0, layout).rect, layout, "{layout:?}");
      assert_eq!(track.state_at(1_000.0, layout).rect, layout, "{layout:?}");
    }
  }

  #[test]
  fn many_regions_never_produce_a_non_finite_box() {
    let regions: Vec<WebcamZoomRegion> = (0..10)
      .map(|i| {
        region(
          (i as f64 * 2_000.0, i as f64 * 2_000.0 + 1_000.0),
          150.0,
          target(200.0 + i as f32 * 150.0, 120.0 + i as f32 * 80.0),
          i % 2 == 0,
        )
      })
      .collect();
    let track = WebcamZoomTrack::new(regions);
    for step in 0..800 {
      let at = step as f64 * 25.0;
      let state = track.state_at(at, BASE);
      assert!(
        state.rect.width.is_finite() && state.rect.height.is_finite(),
        "{at}"
      );
      assert!(state.full_screen.is_finite(), "{at}");
      assert!((0.0..=1.0).contains(&state.full_screen), "{at}");
    }
  }
}

// -- cuts --------------------------------------------------------------------

mod cut_matrix {
  use super::*;

  /// Cut sets that between them exercise every normalisation branch.
  fn cut_sets() -> Vec<(&'static str, Vec<Cut>)> {
    let c = |a: f64, b: f64| Cut {
      start_ms: a,
      end_ms: b,
    };
    vec![
      ("none", vec![]),
      ("one", vec![c(5_000.0, 8_000.0)]),
      (
        "two apart",
        vec![c(5_000.0, 8_000.0), c(20_000.0, 22_500.0)],
      ),
      ("touching", vec![c(1_000.0, 2_000.0), c(2_000.0, 3_000.0)]),
      (
        "overlapping",
        vec![c(1_000.0, 3_000.0), c(2_000.0, 4_000.0)],
      ),
      ("nested", vec![c(1_000.0, 9_000.0), c(3_000.0, 4_000.0)]),
      ("unsorted", vec![c(9_000.0, 10_000.0), c(1_000.0, 2_000.0)]),
      ("at the start", vec![c(0.0, 2_000.0)]),
      ("clamped", vec![c(-500.0, 2_000.0)]),
      (
        "many",
        (0..12)
          .map(|i| c(i as f64 * 2_000.0 + 500.0, i as f64 * 2_000.0 + 900.0))
          .collect(),
      ),
    ]
  }

  #[test]
  fn the_composition_clock_never_runs_backwards_for_any_cut_set() {
    for (name, cuts) in cut_sets() {
      let track = CutTrack::new(cuts);
      let mut last = -1.0;
      for step in 0..500 {
        let value = track.to_composition(step as f64 * 50.0);
        assert!(value >= last, "{name} at step {step}");
        last = value;
      }
    }
  }

  #[test]
  fn the_source_clock_never_runs_backwards_for_any_cut_set() {
    for (name, cuts) in cut_sets() {
      let track = CutTrack::new(cuts);
      let mut last = -1.0;
      for step in 0..500 {
        let value = track.to_source(step as f64 * 50.0);
        assert!(value >= last, "{name} at step {step}");
        last = value;
      }
    }
  }

  #[test]
  fn composition_never_runs_ahead_of_source_for_any_cut_set() {
    for (name, cuts) in cut_sets() {
      let track = CutTrack::new(cuts);
      for step in 0..500 {
        let source = step as f64 * 50.0;
        assert!(
          track.to_composition(source) <= source + 1e-9,
          "{name} at {source}"
        );
      }
    }
  }

  #[test]
  fn source_never_runs_behind_composition_for_any_cut_set() {
    for (name, cuts) in cut_sets() {
      let track = CutTrack::new(cuts);
      for step in 0..500 {
        let composition = step as f64 * 50.0;
        assert!(
          track.to_source(composition) >= composition - 1e-9,
          "{name} at {composition}"
        );
      }
    }
  }

  #[test]
  fn composition_to_source_and_back_is_the_identity_for_any_cut_set() {
    for (name, cuts) in cut_sets() {
      let track = CutTrack::new(cuts);
      for step in 0..500 {
        let composition = step as f64 * 50.0;
        assert_eq!(
          track.to_composition(track.to_source(composition)),
          composition,
          "{name} at {composition}"
        );
      }
    }
  }

  #[test]
  fn a_source_frame_outside_every_cut_survives_the_round_trip_for_any_cut_set() {
    for (name, cuts) in cut_sets() {
      let track = CutTrack::new(cuts);
      for step in 0..500 {
        let source = step as f64 * 50.0;
        if track.contains(source) {
          continue;
        }
        assert_eq!(
          track.to_source(track.to_composition(source)),
          source,
          "{name} at {source}"
        );
      }
    }
  }

  #[test]
  fn no_composition_instant_ever_lands_inside_a_cut_for_any_cut_set() {
    // Which is what makes the mapping usable: the playhead can never point at
    // a frame that was removed.
    for (name, cuts) in cut_sets() {
      let track = CutTrack::new(cuts);
      for step in 0..500 {
        let composition = step as f64 * 50.0;
        let source = track.to_source(composition);
        assert!(
          !track.contains(source),
          "{name} at {composition} -> {source}"
        );
      }
    }
  }

  #[test]
  fn containment_and_the_cut_end_agree_for_any_cut_set() {
    for (name, cuts) in cut_sets() {
      let track = CutTrack::new(cuts);
      for step in 0..500 {
        let source = step as f64 * 50.0;
        assert_eq!(
          track.contains(source),
          track.cut_end_at(source).is_some(),
          "{name} at {source}"
        );
      }
    }
  }

  #[test]
  fn the_reported_cut_end_is_never_itself_cut_for_any_cut_set() {
    for (name, cuts) in cut_sets() {
      let track = CutTrack::new(cuts);
      for step in 0..500 {
        let source = step as f64 * 50.0;
        if let Some(end) = track.cut_end_at(source) {
          assert!(!track.contains(end), "{name} at {source} -> {end}");
          assert!(end > source, "{name} at {source} -> {end}");
        }
      }
    }
  }

  #[test]
  fn the_duration_is_never_longer_than_the_file_for_any_cut_set() {
    for (name, cuts) in cut_sets() {
      let track = CutTrack::new(cuts);
      for duration in [0.0, 1_000.0, 30_000.0, 180_000.0] {
        let edit = track.composition_duration(duration);
        assert!(edit <= duration + 1e-9, "{name} at {duration}");
        assert!(edit >= 0.0, "{name} at {duration}");
      }
    }
  }

  #[test]
  fn normalisation_never_leaves_an_overlapping_pair_for_any_cut_set() {
    // Overlaps have to merge or the mapping subtracts the overlap twice.
    for (name, cuts) in cut_sets() {
      let track = CutTrack::new(cuts);
      // Walk the source clock: the amount removed by any point must never
      // exceed that point, which is exactly what double-subtracting breaks.
      for step in 0..500 {
        let source = step as f64 * 50.0;
        let removed = source - track.to_composition(source);
        assert!(removed >= -1e-9, "{name} at {source}");
        assert!(removed <= source + 1e-9, "{name} at {source}");
      }
    }
  }

  #[test]
  fn the_end_of_the_edit_maps_back_to_the_end_of_the_file_for_any_cut_set() {
    for (name, cuts) in cut_sets() {
      let track = CutTrack::new(cuts);
      for duration in [30_000.0f64, 180_000.0] {
        let edit_end = track.composition_duration(duration);
        // Only meaningful when the file does not end inside a cut.
        if track.contains(duration) {
          continue;
        }
        assert_eq!(track.to_source(edit_end), duration, "{name} at {duration}");
      }
    }
  }
}

// -- layout sanitising and layers -------------------------------------------

mod layout_matrix {
  use super::*;

  const BAD_FLOATS: [f32; 3] = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY];

  #[test]
  fn a_webcam_layout_sanitizes_to_something_drawable_for_every_bad_field() {
    for bad in BAD_FLOATS {
      for field in 0..4 {
        let mut rect = Rect {
          x: 10.0,
          y: 10.0,
          width: 100.0,
          height: 100.0,
        };
        match field {
          0 => rect.x = bad,
          1 => rect.y = bad,
          2 => rect.width = bad,
          _ => rect.height = bad,
        }
        let layout = WebcamLayout {
          rect,
          ..Default::default()
        }
        .sanitized();
        let label = format!("{bad} field {field}");
        assert!(layout.rect.x.is_finite(), "{label}");
        assert!(layout.rect.y.is_finite(), "{label}");
        assert!(layout.rect.width.is_finite(), "{label}");
        assert!(layout.rect.height.is_finite(), "{label}");
      }
    }
  }

  #[test]
  fn a_video_layout_covering_any_canvas_is_the_whole_canvas() {
    for (w, h) in [
      (1920u32, 1080u32),
      (1280, 720),
      (1, 1),
      (3840, 2160),
      (0, 0),
    ] {
      let layout = VideoLayout::covering(w, h);
      assert_eq!(layout.rect, Rect::covering(w, h), "{w}x{h}");
      assert_eq!(layout.corner_radius, 0.0, "{w}x{h}");
      assert_eq!(layout.border_width, 0.0, "{w}x{h}");
    }
  }

  #[test]
  fn opacity_is_clamped_into_range_for_every_value() {
    for opacity in [-1e9f32, -1.0, 0.0, 0.5, 1.0, 2.0, 1e9] {
      let layout = WebcamLayout {
        opacity,
        ..Default::default()
      }
      .sanitized();
      assert!((0.0..=1.0).contains(&layout.opacity), "{opacity}");
    }
  }

  #[test]
  fn a_radius_and_border_are_never_negative_for_any_input() {
    for value in [-1e9f32, -1.0, 0.0, 12.0, 1e9] {
      let layout = WebcamLayout {
        corner_radius: value,
        border_width: value,
        ..Default::default()
      }
      .sanitized();
      assert!(layout.corner_radius >= 0.0, "{value}");
      assert!(layout.border_width >= 0.0, "{value}");
    }
  }

  #[test]
  fn every_surviving_shadow_is_visible_and_finite_for_any_stack() {
    let offsets = [
      [0.0f32, 0.0f32],
      [4.0, 4.0],
      [f32::NAN, 0.0],
      [0.0, f32::INFINITY],
    ];
    let blurs = [0.0f32, 12.0, -4.0, f32::NAN];
    let alphas = [0.0f32, 0.5, 1.0];
    let mut stack = Vec::new();
    for offset in offsets {
      for blur in blurs {
        for alpha in alphas {
          stack.push(Shadow {
            offset,
            blur,
            colour: [0.0, 0.0, 0.0, alpha],
          });
        }
      }
    }
    let total = stack.len();
    let layout = WebcamLayout {
      shadows: stack,
      ..Default::default()
    }
    .sanitized();
    assert!(layout.shadows.len() < total, "nothing was filtered out");
    for s in &layout.shadows {
      assert!(s.is_visible());
      assert!(s.blur.is_finite());
      assert!(s.offset.iter().all(|v| v.is_finite()));
    }
  }

  #[test]
  fn a_shadow_quad_always_covers_its_own_silhouette_for_any_style() {
    let shape = Rect {
      x: 100.0,
      y: 100.0,
      width: 320.0,
      height: 180.0,
    };
    for offset in [[0.0f32, 0.0f32], [12.0, -6.0], [-30.0, 30.0]] {
      for blur in [0.0f32, 4.0, 20.0, 80.0] {
        let s = Shadow {
          offset,
          blur,
          colour: [0.0, 0.0, 0.0, 0.5],
        };
        let quad = s.quad_rect(shape);
        let label = format!("{offset:?} blur {blur}");
        assert!(
          quad.x <= shape.x + offset[0] - s.softness() + 1e-3,
          "{label}"
        );
        assert!(
          quad.x + quad.width >= shape.x + offset[0] + shape.width + s.softness() - 1e-3,
          "{label}"
        );
        assert!(quad.width >= shape.width, "{label}");
        assert!(quad.height >= shape.height, "{label}");
      }
    }
  }

  #[test]
  fn a_crop_resolves_to_something_visible_or_to_nothing_for_every_input() {
    let edges = [-1.0f32, 0.0, 0.05, 0.3, 0.5, 0.95, 1.0, 2.0, f32::NAN];
    for top in edges {
      for left in edges {
        let crop = SourceCrop {
          top,
          left,
          bottom: 0.0,
          right: 0.0,
        };
        if let Some(resolved) = crop.resolve() {
          let label = format!("{top} {left}");
          assert!(
            resolved.top.is_finite() && resolved.left.is_finite(),
            "{label}"
          );
          assert!(
            1.0 - resolved.left - resolved.right >= 0.05 - 1e-4,
            "{label}"
          );
          assert!(
            1.0 - resolved.top - resolved.bottom >= 0.05 - 1e-4,
            "{label}"
          );
        }
      }
    }
  }

  #[test]
  fn resolving_a_crop_is_idempotent_for_every_input_that_survives() {
    let edges = [0.0f32, 0.1, 0.3, 0.5, 0.9, 2.0];
    for top in edges {
      for left in edges {
        let crop = SourceCrop {
          top,
          left,
          bottom: 0.0,
          right: 0.0,
        };
        if let Some(once) = crop.resolve() {
          assert_eq!(once.resolve(), Some(once), "{top} {left}");
        }
      }
    }
  }

  #[test]
  fn every_layer_list_yields_each_layer_exactly_once() {
    let names = ["video", "webcam", "cursor", "background", "sparkles", ""];
    // Every ordered list of up to three names drawn from that set.
    for a in names {
      for b in names {
        for c in names {
          let list = vec![a.to_string(), b.to_string(), c.to_string()];
          let order = parse_layer_order(&list);
          for layer in [Layer::Video, Layer::Webcam, Layer::Cursor] {
            assert_eq!(
              order.iter().filter(|l| **l == layer).count(),
              1,
              "{a} {b} {c} missing or repeated {layer:?}"
            );
          }
        }
      }
    }
  }

  #[test]
  fn a_named_layer_never_ends_up_behind_an_unnamed_one() {
    // Naming a layer moves it to the front of the order; whatever was not
    // named keeps its default position after it.
    for name in ["video", "webcam", "cursor"] {
      let order = parse_layer_order(&[name.to_string()]);
      let named = match name {
        "video" => Layer::Video,
        "webcam" => Layer::Webcam,
        _ => Layer::Cursor,
      };
      assert_eq!(order[0], named, "{name}");
    }
  }
}

// -- cursor ------------------------------------------------------------------

mod cursor_matrix {
  use super::*;

  fn at(timestamp_ms: f64, x: f32, y: f32) -> CursorSample {
    CursorSample {
      timestamp_ms,
      x,
      y,
      visible: true,
      image_id: None,
      click: false,
    }
  }

  #[test]
  fn a_track_holds_its_last_sample_for_every_query_after_it() {
    let counts = [1usize, 2, 5, 50];
    for count in counts {
      let samples: Vec<CursorSample> = (0..count)
        .map(|i| at(i as f64 * 100.0, i as f32 / count as f32, 0.5))
        .collect();
      let last_x = samples[count - 1].x;
      let track = CursorTrack::new(samples);
      for after in [0.0, 1_000.0, 1e6] {
        let query = (count as f64 - 1.0) * 100.0 + after;
        assert_eq!(
          track.sample_at(query).unwrap().x,
          last_x,
          "{count} at {query}"
        );
      }
    }
  }

  #[test]
  fn a_track_returns_nothing_before_its_first_sample_for_any_start() {
    for start in [0.0f64, 100.0, 5_000.0] {
      let track = CursorTrack::new(vec![at(start, 0.5, 0.5)]);
      for before in [1.0f64, 10.0, 1_000.0] {
        assert!(
          track.sample_at(start - before).is_none(),
          "{start} - {before}"
        );
      }
      assert!(track.sample_at(start).is_some(), "{start}");
    }
  }

  #[test]
  fn the_click_scale_never_leaves_one_and_the_peak_for_any_combination() {
    for peak in [0.5f32, 1.0, 1.2, 1.5, 3.0] {
      for duration in [0.0f64, 50.0, 200.0, 1_000.0] {
        let mut clicked = at(1_000.0, 0.5, 0.5);
        clicked.click = true;
        let track = CursorTrack::new(vec![clicked]);
        let (lo, hi) = if peak >= 1.0 {
          (1.0, peak)
        } else {
          (peak, 1.0)
        };
        for step in 0..40 {
          let query = 900.0 + step as f64 * 40.0;
          let scale = track.click_scale_at(query, peak, duration);
          let label = format!("peak {peak} duration {duration} at {query}");
          assert!(scale.is_finite(), "{label}");
          assert!(scale >= lo - 1e-4 && scale <= hi + 1e-4, "{label}: {scale}");
        }
      }
    }
  }

  #[test]
  fn a_click_always_returns_to_rest_after_its_duration_for_any_peak() {
    for peak in [1.2f32, 1.5, 3.0] {
      for duration in [50.0f64, 200.0, 1_000.0] {
        let mut clicked = at(1_000.0, 0.5, 0.5);
        clicked.click = true;
        let track = CursorTrack::new(vec![clicked]);
        assert_eq!(
          track.click_scale_at(1_000.0 + duration, peak, duration),
          1.0,
          "peak {peak} duration {duration}"
        );
      }
    }
  }

  #[test]
  fn motion_is_finite_or_absent_for_every_sample_spacing() {
    for gap in [0.0f64, 1.0, 16.0, 34.0, 100.0, 259.0, 260.0, 261.0, 1_000.0] {
      let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(gap, 0.5, 0.25)]);
      for query in [gap, gap + 10.0, gap + 100.0, gap + 1_000.0] {
        if let Some(motion) = track.motion_at(query) {
          let label = format!("gap {gap} at {query}");
          assert!(motion.vx.is_finite() && motion.vy.is_finite(), "{label}");
        }
      }
    }
  }

  #[test]
  fn motion_always_expires_eventually_for_every_gap() {
    // The track holds its last sample forever; the velocity must not.
    for gap in [1.0f64, 16.0, 34.0, 100.0, 259.0] {
      let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(gap, 0.5, 0.25)]);
      assert!(track.motion_at(gap + 1_000.0).is_none(), "gap {gap}");
    }
  }

  #[test]
  fn a_smear_quad_always_contains_its_own_sprite_for_every_travel() {
    let head = Rect {
      x: 100.0,
      y: 100.0,
      width: 24.0,
      height: 24.0,
    };
    for tx in [-200.0f32, -24.0, -1.0, 0.0, 1.0, 24.0, 200.0] {
      for ty in [-200.0f32, -1.0, 0.0, 1.0, 200.0] {
        let Some((quad, uv, travel)) = smear_geometry(head, [tx, ty]) else {
          assert!(tx == 0.0 && ty == 0.0, "no quad for {tx},{ty}");
          continue;
        };
        let label = format!("{tx},{ty}");
        assert!(quad.x <= head.x + 1e-3, "{label}");
        assert!(quad.y <= head.y + 1e-3, "{label}");
        assert!(quad.x + quad.width >= head.x + head.width - 1e-3, "{label}");
        assert!(
          quad.y + quad.height >= head.y + head.height - 1e-3,
          "{label}"
        );
        assert!(uv.scale.iter().all(|v| *v >= 1.0 - 1e-3), "{label}");
        assert!(travel.iter().all(|v| v.is_finite()), "{label}");
      }
    }
  }

  #[test]
  fn hidden_spans_and_the_cursor_track_can_disagree_without_either_breaking() {
    // The camera's cut spans and the pointer's visibility are independent.
    let hidden = HiddenSpans::new(vec![(1_000.0, 2_000.0)]);
    let mut invisible = at(1_500.0, 0.5, 0.5);
    invisible.visible = false;
    let track = CursorTrack::new(vec![at(0.0, 0.1, 0.1), invisible, at(2_500.0, 0.9, 0.9)]);
    for step in 0..40 {
      let query = step as f64 * 100.0;
      let _ = hidden.contains(query);
      let _ = track.sample_at(query);
    }
    assert!(track.sample_at(1_600.0).is_none());
    assert!(track.sample_at(2_600.0).is_some());
  }

  #[test]
  fn an_overlay_shape_is_carried_through_sanitising_either_way() {
    for shape in [OverlayShape::Rect, OverlayShape::Ellipse] {
      let layout = WebcamLayout {
        shape,
        rect: Rect {
          x: 0.0,
          y: 0.0,
          width: 100.0,
          height: 100.0,
        },
        ..Default::default()
      }
      .sanitized();
      assert_eq!(layout.shape, shape);
    }
  }
}
