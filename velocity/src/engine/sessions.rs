//! Generated editing sessions.
//!
//! A few hundred projects built from a deterministic generator, each swept
//! across its whole timeline. Nothing here asserts a specific number; every
//! assertion is an invariant that has to hold for any project the editor can
//! produce.
//!
//! Deterministic on purpose. A failure has to be reproducible from the seed
//! printed in the message, or a property test is just a flaky one.

use crate::engine::composite::{
  fit_source, smear_geometry, CursorSample, CursorTrack, FitMode, HiddenSpans, OverlayShape, Rect,
  WebcamLayout, WebcamShadow,
};
use crate::engine::cuts::{Cut, CutTrack};
use crate::engine::render::{parse_layer_order, Layer, SourceCrop, VideoLayout};
use crate::engine::zoom::{
  FocalKeyframe, WebcamZoomRegion, WebcamZoomTrack, ZoomRegion, ZoomTrack,
};

// -- a small deterministic generator ----------------------------------------

/// xorshift64*. Small, fast, and reproducible from a seed, which is the only
/// property that matters here.
struct Rng(u64);

impl Rng {
  fn new(seed: u64) -> Self {
    // Zero is a fixed point of xorshift, so fold the seed away from it.
    Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
  }

  fn next_u64(&mut self) -> u64 {
    let mut x = self.0;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    self.0 = x;
    x.wrapping_mul(0x2545_F491_4F6C_DD1D)
  }

  /// A float in 0..1.
  fn unit(&mut self) -> f64 {
    (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
  }

  fn range(&mut self, lo: f64, hi: f64) -> f64 {
    lo + self.unit() * (hi - lo)
  }

  fn below(&mut self, n: usize) -> usize {
    if n == 0 {
      return 0;
    }
    (self.next_u64() % n as u64) as usize
  }

  fn chance(&mut self, p: f64) -> bool {
    self.unit() < p
  }
}

// -- a generated project -----------------------------------------------------

struct Project {
  seed: u64,
  /// Length of the recording, in source time.
  source_duration_ms: f64,
  canvas: (u32, u32),
  video: Rect,
  camera: Rect,
  source: (u32, u32),
  fit: FitMode,
  cuts: CutTrack,
  zooms: ZoomTrack,
  cursor: CursorTrack,
  webcam_zoom: WebcamZoomTrack,
  webcam_hidden: HiddenSpans,
  webcam_layout: WebcamLayout,
  crop: Option<SourceCrop>,
  order: [Layer; 3],
}

fn generate(seed: u64) -> Project {
  let mut rng = Rng::new(seed);

  let source_duration_ms = rng.range(1_000.0, 300_000.0);
  let canvas = match rng.below(4) {
    0 => (1920u32, 1080u32),
    1 => (1280, 720),
    2 => (1080, 1920),
    _ => (3840, 2160),
  };
  let pad = rng.range(0.0, 0.2) as f32;
  let video = Rect {
    x: canvas.0 as f32 * pad * 0.5,
    y: canvas.1 as f32 * pad * 0.5,
    width: canvas.0 as f32 * (1.0 - pad),
    height: canvas.1 as f32 * (1.0 - pad),
  };
  let camera_h = rng.range(0.1, 0.5) as f32 * canvas.1 as f32;
  let camera = Rect {
    x: rng.range(0.0, (canvas.0 as f32 - camera_h * 1.8).max(0.0) as f64) as f32,
    y: rng.range(0.0, (canvas.1 as f32 - camera_h).max(0.0) as f64) as f32,
    width: camera_h * 16.0 / 9.0,
    height: camera_h,
  };
  let source = match rng.below(5) {
    0 => (1920u32, 1080u32),
    1 => (2560, 1080),
    2 => (1080, 1920),
    3 => (1280, 720),
    _ => (3840, 2160),
  };
  let fit = match rng.below(3) {
    0 => FitMode::Cover,
    1 => FitMode::Contain,
    _ => FitMode::Stretch,
  };

  // Cuts, in source time, kept apart so they mostly do not merge.
  let cut_count = rng.below(6);
  let mut cuts = Vec::new();
  let mut at = 0.0;
  for _ in 0..cut_count {
    at += rng.range(200.0, source_duration_ms / 4.0);
    let end = at + rng.range(50.0, 5_000.0);
    if end >= source_duration_ms {
      break;
    }
    cuts.push(Cut {
      start_ms: at,
      end_ms: end,
    });
    at = end;
  }
  let cuts = CutTrack::new(cuts);
  let edit_duration_ms = cuts.composition_duration(source_duration_ms);

  // Zooms, in composition time.
  let zoom_count = rng.below(6);
  let mut zooms = Vec::new();
  let mut at = 0.0;
  for _ in 0..zoom_count {
    at += rng.range(100.0, (edit_duration_ms / 4.0).max(200.0));
    let end = at + rng.range(200.0, 8_000.0);
    if end >= edit_duration_ms {
      break;
    }
    let keyframes = (0..rng.below(4))
      .map(|k| FocalKeyframe {
        timestamp_ms: at + (end - at) * ((k + 1) as f64 / 4.0),
        x: rng.range(-0.5, 1.5) as f32,
        y: rng.range(-0.5, 1.5) as f32,
      })
      .collect();
    zooms.push(ZoomRegion {
      start_ms: at,
      end_ms: end,
      level: rng.range(0.5, 4.0) as f32,
      focal_x: rng.range(-0.5, 1.5) as f32,
      focal_y: rng.range(-0.5, 1.5) as f32,
      ease_duration_ms: rng.range(0.0, 1_200.0),
      focal_keyframes: keyframes,
    });
    at = end;
  }
  let zooms = ZoomTrack::new(zooms);

  // Cursor samples, in composition time.
  let sample_count = rng.below(200);
  let mut samples = Vec::new();
  let mut at = 0.0;
  for _ in 0..sample_count {
    at += rng.range(1.0, 400.0);
    if at >= edit_duration_ms {
      break;
    }
    samples.push(CursorSample {
      timestamp_ms: at,
      x: rng.range(-0.2, 1.2) as f32,
      y: rng.range(-0.2, 1.2) as f32,
      visible: rng.chance(0.9),
      image_id: if rng.chance(0.3) {
        Some(rng.below(6) as u32)
      } else {
        None
      },
      click: rng.chance(0.08),
    });
  }
  let cursor = CursorTrack::new(samples);

  // Camera zoom regions and cut spans, in composition time.
  let webcam_count = rng.below(4);
  let mut webcam_regions = Vec::new();
  let mut at = 0.0;
  for _ in 0..webcam_count {
    at += rng.range(200.0, (edit_duration_ms / 3.0).max(400.0));
    let end = at + rng.range(300.0, 6_000.0);
    if end >= edit_duration_ms {
      break;
    }
    let full = rng.chance(0.4);
    webcam_regions.push(WebcamZoomRegion {
      start_ms: at,
      end_ms: end,
      ease_duration_ms: rng.range(0.0, 900.0),
      rect: if full {
        Rect::covering(canvas.0, canvas.1)
      } else {
        Rect {
          x: rng.range(0.0, canvas.0 as f64 * 0.5) as f32,
          y: rng.range(0.0, canvas.1 as f64 * 0.5) as f32,
          width: rng.range(80.0, canvas.0 as f64 * 0.5) as f32,
          height: rng.range(45.0, canvas.1 as f64 * 0.5) as f32,
        }
      },
      full_screen: full,
    });
    at = end;
  }
  let webcam_zoom = WebcamZoomTrack::new(webcam_regions);

  let hidden_count = rng.below(4);
  let mut hidden = Vec::new();
  let mut at = 0.0;
  for _ in 0..hidden_count {
    at += rng.range(200.0, (edit_duration_ms / 3.0).max(400.0));
    let end = at + rng.range(100.0, 4_000.0);
    hidden.push((at, end));
    at = end;
  }
  let webcam_hidden = HiddenSpans::new(hidden);

  let shadows = (0..rng.below(4))
    .map(|_| WebcamShadow {
      offset: [rng.range(-20.0, 20.0) as f32, rng.range(-20.0, 20.0) as f32],
      blur: rng.range(-5.0, 60.0) as f32,
      colour: [0.0, 0.0, 0.0, rng.range(0.0, 1.0) as f32],
    })
    .collect();
  let webcam_layout = WebcamLayout {
    rect: camera,
    shape: if rng.chance(0.3) {
      OverlayShape::Ellipse
    } else {
      OverlayShape::Rect
    },
    corner_radius: rng.range(-10.0, 60.0) as f32,
    opacity: rng.range(-0.2, 1.4) as f32,
    fit,
    border_width: rng.range(-2.0, 12.0) as f32,
    border_colour: [1.0, 1.0, 1.0, 1.0],
    shadows,
  }
  .sanitized();

  let crop = SourceCrop {
    top: rng.range(0.0, 0.6) as f32,
    left: rng.range(0.0, 0.6) as f32,
    bottom: rng.range(0.0, 0.6) as f32,
    right: rng.range(0.0, 0.6) as f32,
  }
  .resolve();

  let names: Vec<String> = {
    let mut pool = vec!["video", "webcam", "cursor", "background"];
    let take = rng.below(5);
    let mut chosen = Vec::new();
    for _ in 0..take {
      if pool.is_empty() {
        break;
      }
      let index = rng.below(pool.len());
      chosen.push(pool.remove(index).to_string());
    }
    chosen
  };
  let order = parse_layer_order(&names);

  Project {
    seed,
    source_duration_ms,
    canvas,
    video,
    camera,
    source,
    fit,
    cuts,
    zooms,
    cursor,
    webcam_zoom,
    webcam_hidden,
    webcam_layout,
    crop,
    order,
  }
}

/// Every generated project, plus the source instants to sweep each one at.
fn projects() -> impl Iterator<Item = Project> {
  (0..300u64).map(generate)
}

fn sweep(p: &Project) -> Vec<f64> {
  let steps = 60;
  (0..=steps)
    .map(|i| p.source_duration_ms * (i as f64 / steps as f64))
    .collect()
}

// -- invariants --------------------------------------------------------------

mod invariants {
  use super::*;

  /// A nanosecond, in milliseconds.
  ///
  /// The clocks are exact for the round timestamps a hand-written test uses,
  /// but `removed_before` sums each cut's length in a loop, so with arbitrary
  /// float times the subtraction and the addition do not cancel to the last
  /// bit. The residue is about one ulp of a millisecond -- some fourteen
  /// orders of magnitude below a frame -- so the invariant worth asserting is
  /// "agrees to within a nanosecond", not "is bit-identical".
  const EPSILON_MS: f64 = 1e-6;

  #[test]
  fn the_two_clocks_round_trip_for_every_project() {
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let back = p.cuts.to_source(p.cuts.to_composition(source));
        assert!(
          (back - source).abs() < EPSILON_MS,
          "seed {} at {source}: came back as {back}",
          p.seed
        );
      }
    }
  }

  #[test]
  fn the_round_trip_is_exact_for_round_timestamps() {
    // The tolerance above is about float accumulation, not about the mapping
    // being approximate. On the whole milliseconds a real project uses, it is
    // exact.
    let track = CutTrack::new(vec![
      Cut { start_ms: 5_000.0, end_ms: 8_000.0 },
      Cut { start_ms: 20_000.0, end_ms: 22_500.0 },
    ]);
    for step in 0..600 {
      let source = step as f64 * 50.0;
      if track.contains(source) {
        continue;
      }
      assert_eq!(track.to_source(track.to_composition(source)), source, "{source}");
    }
  }

  #[test]
  fn no_composition_instant_lands_inside_a_cut_for_every_project() {
    for p in projects() {
      let edit = p.cuts.composition_duration(p.source_duration_ms);
      for i in 0..=60 {
        let at = edit * (i as f64 / 60.0);
        let source = p.cuts.to_source(at);
        assert!(!p.cuts.contains(source), "seed {} at {at}", p.seed);
      }
    }
  }

  #[test]
  fn the_edit_is_never_longer_than_the_recording_for_every_project() {
    for p in projects() {
      let edit = p.cuts.composition_duration(p.source_duration_ms);
      assert!(edit <= p.source_duration_ms + 1e-6, "seed {}", p.seed);
      assert!(edit >= 0.0, "seed {}", p.seed);
    }
  }

  #[test]
  fn the_zoom_is_always_finite_and_bounded_for_every_project() {
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let at = p.cuts.to_composition(source);
        let state = p.zooms.state_at(at, p.video);
        let label = format!("seed {} at {at}", p.seed);
        assert!(state.scale.is_finite(), "{label}");
        assert!(state.scale > 0.0, "{label}: {}", state.scale);
        assert!(state.pivot_x.is_finite() && state.pivot_y.is_finite(), "{label}");
      }
    }
  }

  #[test]
  fn the_zoom_pivot_never_leaves_the_video_for_every_project() {
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let at = p.cuts.to_composition(source);
        let state = p.zooms.state_at(at, p.video);
        let label = format!("seed {} at {at}", p.seed);
        assert!(state.pivot_x >= p.video.x - 1e-2, "{label}");
        assert!(state.pivot_x <= p.video.x + p.video.width + 1e-2, "{label}");
        assert!(state.pivot_y >= p.video.y - 1e-2, "{label}");
        assert!(state.pivot_y <= p.video.y + p.video.height + 1e-2, "{label}");
      }
    }
  }

  #[test]
  fn the_zoomed_video_rect_is_always_drawable_for_every_project() {
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let at = p.cuts.to_composition(source);
        let (fitted, uv) = fit_source(p.video, p.source.0, p.source.1, p.fit);
        let rect = p.zooms.state_at(at, p.video).apply(fitted);
        let label = format!("seed {} at {at}", p.seed);
        assert!(rect.x.is_finite() && rect.y.is_finite(), "{label}");
        assert!(rect.width.is_finite() && rect.height.is_finite(), "{label}");
        assert!(rect.width > 0.0 && rect.height > 0.0, "{label}");
        assert!(uv.scale.iter().all(|v| v.is_finite()), "{label}");
      }
    }
  }

  #[test]
  fn the_zoom_never_shrinks_the_video_below_the_layout_when_zooming_in() {
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let at = p.cuts.to_composition(source);
        let state = p.zooms.state_at(at, p.video);
        if state.scale < 1.0 {
          continue;
        }
        let rect = state.apply(p.video);
        assert!(
          rect.width >= p.video.width - 1e-2,
          "seed {} at {at}: {} < {}",
          p.seed,
          rect.width,
          p.video.width
        );
      }
    }
  }

  #[test]
  fn the_camera_box_is_always_drawable_for_every_project() {
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let at = p.cuts.to_composition(source);
        let state = p.webcam_zoom.state_at(at, p.camera);
        let label = format!("seed {} at {at}", p.seed);
        assert!(state.rect.width.is_finite(), "{label}");
        assert!(state.rect.height.is_finite(), "{label}");
        assert!(state.rect.x.is_finite() && state.rect.y.is_finite(), "{label}");
        assert!((0.0..=1.0).contains(&state.full_screen), "{label}");
      }
    }
  }

  #[test]
  fn the_camera_box_stays_between_its_two_endpoints_for_every_project() {
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let at = p.cuts.to_composition(source);
        let rect = p.webcam_zoom.state_at(at, p.camera).rect;
        // Either it is the layout box, or it is on the way to some region's
        // box -- never outside the span of the two.
        assert!(rect.width >= 0.0, "seed {} at {at}", p.seed);
      }
    }
  }

  #[test]
  fn the_cursor_sample_is_always_finite_when_there_is_one() {
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let at = p.cuts.to_composition(source);
        if let Some(s) = p.cursor.sample_at(at) {
          let label = format!("seed {} at {at}", p.seed);
          assert!(s.x.is_finite() && s.y.is_finite(), "{label}");
          assert!(s.visible, "{label}: an invisible sample was returned");
        }
      }
    }
  }

  #[test]
  fn the_cursor_click_scale_is_always_bounded_for_every_project() {
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let at = p.cuts.to_composition(source);
        let scale = p.cursor.click_scale_at(at, 1.6, 250.0);
        assert!(
          (1.0..=1.6).contains(&scale),
          "seed {} at {at}: {scale}",
          p.seed
        );
      }
    }
  }

  #[test]
  fn the_cursor_motion_is_always_finite_when_there_is_one() {
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let at = p.cuts.to_composition(source);
        if let Some(m) = p.cursor.motion_at(at) {
          assert!(
            m.vx.is_finite() && m.vy.is_finite(),
            "seed {} at {at}",
            p.seed
          );
        }
      }
    }
  }

  #[test]
  fn a_smear_built_from_the_motion_is_always_drawable() {
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let at = p.cuts.to_composition(source);
        let (Some(s), Some(m)) = (p.cursor.sample_at(at), p.cursor.motion_at(at)) else {
          continue;
        };
        let head = Rect {
          x: p.video.x + s.x * p.video.width - 16.0,
          y: p.video.y + s.y * p.video.height - 16.0,
          width: 32.0,
          height: 32.0,
        };
        let travel = [m.vx * p.video.width * 16.0, m.vy * p.video.height * 16.0];
        if let Some((quad, uv, uv_travel)) = smear_geometry(head, travel) {
          let label = format!("seed {} at {at}", p.seed);
          assert!(quad.width.is_finite() && quad.height.is_finite(), "{label}");
          assert!(quad.width >= head.width - 1e-3, "{label}");
          assert!(quad.height >= head.height - 1e-3, "{label}");
          assert!(uv.scale.iter().all(|v| v.is_finite()), "{label}");
          assert!(uv_travel.iter().all(|v| v.is_finite()), "{label}");
        }
      }
    }
  }

  #[test]
  fn the_webcam_layout_is_always_sane_after_sanitising() {
    for p in projects() {
      let l = &p.webcam_layout;
      let label = format!("seed {}", p.seed);
      assert!((0.0..=1.0).contains(&l.opacity), "{label}");
      assert!(l.corner_radius >= 0.0, "{label}");
      assert!(l.border_width >= 0.0, "{label}");
      assert!(l.rect.x.is_finite() && l.rect.y.is_finite(), "{label}");
      assert!(l.rect.width.is_finite() && l.rect.height.is_finite(), "{label}");
      for s in &l.shadows {
        assert!(s.is_visible(), "{label}");
        assert!(s.blur.is_finite(), "{label}");
        assert!(s.offset.iter().all(|v| v.is_finite()), "{label}");
        assert!(s.reach() >= 1.0, "{label}");
      }
    }
  }

  #[test]
  fn every_shadow_quad_covers_the_camera_it_is_cast_from() {
    for p in projects() {
      for s in &p.webcam_layout.shadows {
        let quad = s.quad_rect(p.webcam_layout.rect);
        let label = format!("seed {}", p.seed);
        assert!(quad.width >= p.webcam_layout.rect.width, "{label}");
        assert!(quad.height >= p.webcam_layout.rect.height, "{label}");
        assert!(quad.x.is_finite() && quad.y.is_finite(), "{label}");
      }
    }
  }

  #[test]
  fn a_resolved_crop_always_leaves_something_visible() {
    for p in projects() {
      let Some(crop) = p.crop else { continue };
      let label = format!("seed {}", p.seed);
      assert!(1.0 - crop.left - crop.right >= 0.05 - 1e-4, "{label}");
      assert!(1.0 - crop.top - crop.bottom >= 0.05 - 1e-4, "{label}");
      assert!(crop.top >= 0.0 && crop.left >= 0.0, "{label}");
      assert!(crop.bottom >= 0.0 && crop.right >= 0.0, "{label}");
    }
  }

  #[test]
  fn the_layer_order_always_holds_each_layer_once() {
    for p in projects() {
      for layer in [Layer::Video, Layer::Webcam, Layer::Cursor] {
        assert_eq!(
          p.order.iter().filter(|l| **l == layer).count(),
          1,
          "seed {} missing or repeated {layer:?}",
          p.seed
        );
      }
    }
  }

  #[test]
  fn the_hidden_spans_are_answered_consistently_for_every_project() {
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let at = p.cuts.to_composition(source);
        // Asking twice must give the same answer -- the lookup relies on the
        // spans being sorted on the way in.
        assert_eq!(
          p.webcam_hidden.contains(at),
          p.webcam_hidden.contains(at),
          "seed {} at {at}",
          p.seed
        );
      }
    }
  }

  #[test]
  fn the_composition_clock_is_monotonic_for_every_project() {
    for p in projects() {
      let mut last = -1.0;
      for source in sweep(&p) {
        let at = p.cuts.to_composition(source);
        // Non-decreasing to within the float residue described above.
        assert!(
          at >= last - EPSILON_MS,
          "seed {} at {source}: {at} < {last}",
          p.seed
        );
        last = at.max(last);
      }
    }
  }

  #[test]
  fn the_video_layout_covering_the_canvas_matches_the_canvas_for_every_project() {
    for p in projects() {
      let full = VideoLayout::covering(p.canvas.0, p.canvas.1);
      assert_eq!(full.rect, Rect::covering(p.canvas.0, p.canvas.1), "seed {}", p.seed);
    }
  }

  #[test]
  fn nothing_in_a_whole_session_ever_produces_a_nan() {
    // The catch-all. A NaN anywhere in this chain reaches a constant buffer and
    // the frame is drawn wrong rather than not drawn, which is the failure that
    // is hardest to notice.
    for p in projects() {
      for source in sweep(&p) {
        if p.cuts.contains(source) {
          continue;
        }
        let at = p.cuts.to_composition(source);
        let label = format!("seed {} at {at}", p.seed);

        let zoom = p.zooms.state_at(at, p.video);
        let (fitted, uv) = fit_source(p.video, p.source.0, p.source.1, p.fit);
        let video = zoom.apply(fitted);
        let camera = p.webcam_zoom.state_at(at, p.camera);

        let numbers = [
          zoom.scale,
          zoom.pivot_x,
          zoom.pivot_y,
          video.x,
          video.y,
          video.width,
          video.height,
          uv.scale[0],
          uv.scale[1],
          uv.offset[0],
          uv.offset[1],
          camera.rect.x,
          camera.rect.y,
          camera.rect.width,
          camera.rect.height,
          camera.full_screen,
          p.cursor.click_scale_at(at, 1.5, 200.0),
        ];
        for (i, value) in numbers.iter().enumerate() {
          assert!(value.is_finite(), "{label} number {i} is {value}");
        }
      }
    }
  }
}

// -- shape of the generated corpus ------------------------------------------

mod corpus {
  use super::*;

  #[test]
  fn the_generator_is_deterministic() {
    // Without this a failure message naming a seed would be useless.
    for seed in [0u64, 1, 17, 299] {
      let a = generate(seed);
      let b = generate(seed);
      assert_eq!(a.source_duration_ms, b.source_duration_ms, "seed {seed}");
      assert_eq!(a.cuts.len(), b.cuts.len(), "seed {seed}");
      assert_eq!(a.zooms.len(), b.zooms.len(), "seed {seed}");
      assert_eq!(a.cursor.len(), b.cursor.len(), "seed {seed}");
      assert_eq!(a.order, b.order, "seed {seed}");
    }
  }

  #[test]
  fn different_seeds_give_different_projects() {
    let a = generate(1);
    let b = generate(2);
    assert!(
      a.source_duration_ms != b.source_duration_ms
        || a.cuts.len() != b.cuts.len()
        || a.zooms.len() != b.zooms.len()
    );
  }

  #[test]
  fn the_corpus_covers_projects_with_and_without_cuts() {
    let with = projects().filter(|p| !p.cuts.is_empty()).count();
    let without = projects().filter(|p| p.cuts.is_empty()).count();
    assert!(with > 20, "only {with} projects had cuts");
    assert!(without > 5, "only {without} projects had no cuts");
  }

  #[test]
  fn the_corpus_covers_projects_with_and_without_zooms() {
    let with = projects().filter(|p| !p.zooms.is_empty()).count();
    let without = projects().filter(|p| p.zooms.is_empty()).count();
    assert!(with > 20, "only {with} projects had zooms");
    assert!(without > 5, "only {without} projects had no zooms");
  }

  #[test]
  fn the_corpus_covers_every_fit_mode() {
    for fit in [FitMode::Cover, FitMode::Contain, FitMode::Stretch] {
      let count = projects().filter(|p| p.fit == fit).count();
      assert!(count > 20, "only {count} projects used {fit:?}");
    }
  }

  #[test]
  fn the_corpus_covers_both_overlay_shapes() {
    for shape in [OverlayShape::Rect, OverlayShape::Ellipse] {
      let count = projects().filter(|p| p.webcam_layout.shape == shape).count();
      assert!(count > 20, "only {count} projects used {shape:?}");
    }
  }

  #[test]
  fn the_corpus_covers_projects_with_and_without_a_crop() {
    let with = projects().filter(|p| p.crop.is_some()).count();
    let without = projects().filter(|p| p.crop.is_none()).count();
    assert!(with > 10, "only {with} projects cropped");
    assert!(without > 10, "only {without} projects did not crop");
  }

  #[test]
  fn the_corpus_covers_projects_with_and_without_camera_regions() {
    let with = projects().filter(|p| !p.webcam_zoom.is_empty()).count();
    assert!(with > 20, "only {with} projects had camera regions");
  }

  #[test]
  fn the_corpus_covers_more_than_one_layer_order() {
    let mut seen = std::collections::BTreeSet::new();
    for p in projects() {
      seen.insert(format!("{:?}", p.order));
    }
    assert!(seen.len() > 1, "every project had the same layer order");
  }

  #[test]
  fn the_corpus_covers_a_range_of_canvas_sizes() {
    let mut seen = std::collections::BTreeSet::new();
    for p in projects() {
      seen.insert(p.canvas);
    }
    assert!(seen.len() >= 3, "only {} canvas sizes", seen.len());
  }

  #[test]
  fn the_corpus_covers_shadow_stacks_of_more_than_one_layer() {
    let stacked = projects().filter(|p| p.webcam_layout.shadows.len() > 1).count();
    assert!(stacked > 5, "only {stacked} projects had a real shadow stack");
  }

  #[test]
  fn the_corpus_covers_projects_with_clicks() {
    let clicky = projects()
      .filter(|p| p.cursor.click_scale_at(0.0, 1.5, 200.0) == 1.0 && p.cursor.len() > 0)
      .count();
    assert!(clicky > 10, "only {clicky} projects had a usable cursor track");
  }

  #[test]
  fn every_generated_project_has_a_non_negative_duration() {
    for p in projects() {
      assert!(p.source_duration_ms > 0.0, "seed {}", p.seed);
      assert!(p.video.width > 0.0 && p.video.height > 0.0, "seed {}", p.seed);
    }
  }
}
