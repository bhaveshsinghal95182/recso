//! The zoom/pan timeline.
//!
//! recso's signature feature: a region of the timeline where the recording
//! scales up around a focal point, eased in and out, optionally panning between
//! focal keyframes while it is held.
//!
//! The editor's Canvas2D compositor does this as a canvas transform --
//! `translate(pivot)`, `scale(s)`, `translate(-pivot)` -- applied to whichever
//! layers are in "zoomed" space. This engine has no transform stack and does
//! not need one: every layer is an axis-aligned quad placed by a rectangle, and
//! scaling an axis-aligned rect about a pivot is exactly what that transform
//! does to it. So a zoom here is arithmetic on two rects rather than state on a
//! context.
//!
//! Which layers move is the same split the compositor uses. The video and the
//! cursor are in zoomed space; the background and the webcam are not, because a
//! zoom is about the *recording* and the camera box is furniture on top of it.

use crate::engine::layout::Rect;

/// A focal point the zoom pans to while a region is held.
///
/// Normalised against the recording, not the canvas -- so a zoom stays on the
/// thing it was pointed at when the video is inset, scaled or moved.
#[derive(Clone, Copy, Debug)]
pub struct FocalKeyframe {
  pub timestamp_ms: f64,
  pub x: f32,
  pub y: f32,
}

/// One span of the timeline that is zoomed in.
#[derive(Clone, Debug)]
pub struct ZoomRegion {
  pub start_ms: f64,
  pub end_ms: f64,
  /// 1.0 is no zoom. The editor's slider is roughly 1..4.
  pub level: f32,
  /// Where it zooms to, normalised against the recording.
  pub focal_x: f32,
  pub focal_y: f32,
  /// How long the ease in and the ease out each take. Zero snaps.
  pub ease_duration_ms: f64,
  /// Extra focal points to pan between. Empty holds `focal_x`/`focal_y`.
  pub focal_keyframes: Vec<FocalKeyframe>,
}

/// How zoomed in the frame is, and about which point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ZoomState {
  pub scale: f32,
  /// Canvas pixels, already mapped through the video's placement.
  pub pivot_x: f32,
  pub pivot_y: f32,
}

impl Default for ZoomState {
  fn default() -> Self {
    Self {
      scale: 1.0,
      pivot_x: 0.0,
      pivot_y: 0.0,
    }
  }
}

impl ZoomState {
  pub fn is_identity(&self) -> bool {
    (self.scale - 1.0).abs() < 1e-6
  }

  /// Scale a rectangle about the pivot.
  ///
  /// The whole of the zoom, for any layer. An axis-aligned rect under
  /// `translate(p) · scale(s) · translate(-p)` is just this, which is why the
  /// engine needs no transform stack to match the compositor.
  pub fn apply(&self, rect: Rect) -> Rect {
    if self.is_identity() {
      return rect;
    }

    Rect {
      x: self.pivot_x + (rect.x - self.pivot_x) * self.scale,
      y: self.pivot_y + (rect.y - self.pivot_y) * self.scale,
      width: rect.width * self.scale,
      height: rect.height * self.scale,
    }
  }
}

/// The zoom regions for a project, in timeline order.
#[derive(Default)]
pub struct ZoomTrack {
  regions: Vec<ZoomRegion>,
}

impl ZoomTrack {
  pub fn new(mut regions: Vec<ZoomRegion>) -> Self {
    // Sorted on the way in so `state_at` can take the first match. Overlapping
    // regions are the caller's problem either way, but "the one that starts
    // first wins" is at least a rule rather than whatever order they arrived in.
    regions.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    Self { regions }
  }

  pub fn len(&self) -> usize {
    self.regions.len()
  }

  pub fn is_empty(&self) -> bool {
    self.regions.is_empty()
  }

  /// The zoom at `timestamp_ms`, with the pivot resolved into canvas pixels.
  ///
  /// `video` is where the recording sits on the canvas. Focal points are
  /// authored against the recording, so they map through that rather than
  /// against the canvas -- otherwise a zoom lands off by the padding: nothing
  /// at the centre, and the full padding at the edges.
  pub fn state_at(&self, timestamp_ms: f64, video: Rect) -> ZoomState {
    let centre = ZoomState {
      scale: 1.0,
      pivot_x: video.x + video.width * 0.5,
      pivot_y: video.y + video.height * 0.5,
    };

    for region in &self.regions {
      if timestamp_ms < region.start_ms || timestamp_ms > region.end_ms {
        continue;
      }

      let eased = ease_at(region, timestamp_ms);
      let (focal_x, focal_y) = focal_at(region, timestamp_ms);

      return ZoomState {
        scale: 1.0 + (region.level - 1.0) * eased,
        pivot_x: video.x + focal_x * video.width,
        pivot_y: video.y + focal_y * video.height,
      };
    }

    centre
  }
}

/// Smoothstep, matching the compositor's `smoothstep` exactly.
fn smoothstep(value: f32) -> f32 {
  let t = value.clamp(0.0, 1.0);
  t * t * (3.0 - 2.0 * t)
}

fn clamp_normalised(value: f32) -> f32 {
  if value.is_finite() {
    value.clamp(0.0, 1.0)
  } else {
    0.0
  }
}

/// How far into the zoom this timestamp is: 0 at the edges, 1 while held.
fn ease_at(region: &ZoomRegion, timestamp_ms: f64) -> f32 {
  let ease = region.ease_duration_ms.max(0.0);
  if ease <= 0.0 {
    return 1.0;
  }

  if timestamp_ms < region.start_ms + ease {
    return smoothstep(((timestamp_ms - region.start_ms) / ease) as f32);
  }

  if timestamp_ms > region.end_ms - ease {
    return smoothstep(((region.end_ms - timestamp_ms) / ease) as f32);
  }

  1.0
}

/// Where the zoom is pointed at this timestamp.
///
/// The region's own focal point is the first keyframe, at its start. With no
/// other keyframes that is the whole answer and the zoom holds still.
fn focal_at(region: &ZoomRegion, timestamp_ms: f64) -> (f32, f32) {
  let base = (
    clamp_normalised(region.focal_x),
    clamp_normalised(region.focal_y),
  );

  if region.focal_keyframes.is_empty() {
    return base;
  }

  let mut points = Vec::with_capacity(region.focal_keyframes.len() + 1);
  points.push(FocalKeyframe {
    timestamp_ms: region.start_ms,
    x: base.0,
    y: base.1,
  });
  points.extend(region.focal_keyframes.iter().map(|point| FocalKeyframe {
    timestamp_ms: point.timestamp_ms,
    x: clamp_normalised(point.x),
    y: clamp_normalised(point.y),
  }));
  points.sort_by(|a, b| a.timestamp_ms.total_cmp(&b.timestamp_ms));

  let first = points[0];
  if timestamp_ms <= first.timestamp_ms {
    return (first.x, first.y);
  }

  let last = points[points.len() - 1];
  if timestamp_ms >= last.timestamp_ms {
    return (last.x, last.y);
  }

  for pair in points.windows(2) {
    let (current, next) = (pair[0], pair[1]);
    if timestamp_ms < current.timestamp_ms || timestamp_ms > next.timestamp_ms {
      continue;
    }

    let span = next.timestamp_ms - current.timestamp_ms;
    if span <= 0.0 {
      return (current.x, current.y);
    }

    // Linear between focal points, like the compositor. The easing is on the
    // zoom level, not the pan: a pan that eased at every keyframe would stutter
    // its way across a long move.
    let mix = ((timestamp_ms - current.timestamp_ms) / span) as f32;
    return (
      current.x + (next.x - current.x) * mix,
      current.y + (next.y - current.y) * mix,
    );
  }

  (last.x, last.y)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn video() -> Rect {
    Rect {
      x: 100.0,
      y: 50.0,
      width: 800.0,
      height: 450.0,
    }
  }

  fn region() -> ZoomRegion {
    ZoomRegion {
      start_ms: 1000.0,
      end_ms: 3000.0,
      level: 2.0,
      focal_x: 0.5,
      focal_y: 0.5,
      ease_duration_ms: 400.0,
      focal_keyframes: Vec::new(),
    }
  }

  #[test]
  fn outside_every_region_the_frame_is_not_zoomed() {
    let track = ZoomTrack::new(vec![region()]);
    let state = track.state_at(500.0, video());

    assert!(state.is_identity());
    // And the pivot is the middle of the video, not the middle of the canvas.
    assert_eq!(state.pivot_x, 500.0);
    assert_eq!(state.pivot_y, 275.0);
  }

  #[test]
  fn the_middle_of_a_region_is_fully_zoomed() {
    let track = ZoomTrack::new(vec![region()]);
    assert_eq!(track.state_at(2000.0, video()).scale, 2.0);
  }

  #[test]
  fn the_edges_of_a_region_are_not_zoomed_at_all() {
    let track = ZoomTrack::new(vec![region()]);
    // Exactly at the boundary the ease has not started, so this is still 1.
    assert!((track.state_at(1000.0, video()).scale - 1.0).abs() < 1e-5);
    assert!((track.state_at(3000.0, video()).scale - 1.0).abs() < 1e-5);
  }

  #[test]
  fn the_ease_is_monotonic_on_the_way_in() {
    let track = ZoomTrack::new(vec![region()]);
    let mut last = 0.0;
    for step in 0..=8 {
      let at = 1000.0 + 400.0 * (step as f64 / 8.0);
      let scale = track.state_at(at, video()).scale;
      assert!(scale >= last, "{scale} < {last} at {at}");
      last = scale;
    }
    assert!((last - 2.0).abs() < 1e-5);
  }

  #[test]
  fn a_pivot_maps_through_the_videos_placement() {
    let mut r = region();
    r.focal_x = 0.0;
    r.focal_y = 0.0;
    let track = ZoomTrack::new(vec![r]);
    let state = track.state_at(2000.0, video());

    // The top-left of the *recording*, which is inset by the canvas padding --
    // not the top-left of the canvas.
    assert_eq!(state.pivot_x, 100.0);
    assert_eq!(state.pivot_y, 50.0);
  }

  #[test]
  fn scaling_about_a_pivot_leaves_the_pivot_where_it_was() {
    let state = ZoomState {
      scale: 2.0,
      pivot_x: 500.0,
      pivot_y: 275.0,
    };
    let zoomed = state.apply(video());

    // The pivot sits at the same fraction of the rect before and after, which
    // is the property that makes this a zoom rather than a move.
    let before = (500.0 - video().x) / video().width;
    let after = (500.0 - zoomed.x) / zoomed.width;
    assert!((before - after).abs() < 1e-5);
    assert_eq!(zoomed.width, 1600.0);
  }

  #[test]
  fn an_identity_zoom_returns_the_rect_untouched() {
    let state = ZoomState::default();
    assert_eq!(state.apply(video()), video());
  }

  #[test]
  fn focal_keyframes_pan_between_themselves() {
    let mut r = region();
    r.focal_x = 0.0;
    r.focal_y = 0.0;
    r.focal_keyframes = vec![FocalKeyframe {
      timestamp_ms: 3000.0,
      x: 1.0,
      y: 1.0,
    }];
    let track = ZoomTrack::new(vec![r]);

    // Half way through the region is half way across the pan.
    let state = track.state_at(2000.0, video());
    assert!((state.pivot_x - (100.0 + 0.5 * 800.0)).abs() < 1e-3);
    assert!((state.pivot_y - (50.0 + 0.5 * 450.0)).abs() < 1e-3);
  }

  #[test]
  fn a_pan_holds_at_its_last_keyframe() {
    let mut r = region();
    r.focal_keyframes = vec![FocalKeyframe {
      timestamp_ms: 2000.0,
      x: 1.0,
      y: 1.0,
    }];
    let track = ZoomTrack::new(vec![r]);

    let state = track.state_at(2900.0, video());
    assert!((state.pivot_x - 900.0).abs() < 1e-3);
  }

  #[test]
  fn regions_are_sorted_so_the_earliest_wins() {
    let mut late = region();
    late.start_ms = 5000.0;
    late.end_ms = 7000.0;
    late.level = 3.0;

    let track = ZoomTrack::new(vec![late, region()]);
    // Built out of order; the one covering this timestamp is still found.
    assert_eq!(track.state_at(2000.0, video()).scale, 2.0);
    assert_eq!(track.state_at(6000.0, video()).scale, 3.0);
  }

  #[test]
  fn a_zero_ease_region_snaps_to_full_zoom() {
    let mut r = region();
    r.ease_duration_ms = 0.0;
    let track = ZoomTrack::new(vec![r]);

    assert_eq!(track.state_at(1000.0, video()).scale, 2.0);
    assert_eq!(track.state_at(2000.0, video()).scale, 2.0);
  }
}

// ---------------------------------------------------------------------------
// The camera's own zoom: a size change, or the whole canvas.
// ---------------------------------------------------------------------------

/// One span where the camera grows, or takes over the frame.
///
/// `rect` is the box at this region's height, **already laid out by the
/// caller**. The engine interpolates between rectangles rather than
/// recomputing one from a height ratio, because the placement formula -- the
/// anchor grid, the margin, the aspect fit -- lives on the JavaScript side on
/// purpose, and a second copy here is exactly how a webcam ends up a different
/// size in the preview than in the export.
///
/// The compositor eases the *ratio* and then lays out; this eases the laid-out
/// rectangle. Those agree wherever the layout is linear in the ratio, which it
/// is until a clamp engages -- and the ratio is already clamped before it gets
/// this far.
#[derive(Clone, Copy, Debug)]
pub struct WebcamZoomRegion {
  pub start_ms: f64,
  pub end_ms: f64,
  pub ease_duration_ms: f64,
  /// The camera's box while this region is fully in effect.
  pub rect: Rect,
  /// Whether the camera expands to fill the canvas over this span.
  pub full_screen: bool,
}

/// What the camera should be doing at one instant.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WebcamZoomState {
  /// The box to draw, already eased between the layout's own and the region's.
  pub rect: Rect,
  /// 0 leaves the box alone; 1 is the whole canvas, with the radius, border and
  /// shape dissolved on the way.
  pub full_screen: f32,
}

#[derive(Default)]
pub struct WebcamZoomTrack {
  regions: Vec<WebcamZoomRegion>,
}

impl WebcamZoomTrack {
  pub fn new(regions: Vec<WebcamZoomRegion>) -> Self {
    Self { regions }
  }

  pub fn is_empty(&self) -> bool {
    self.regions.is_empty()
  }

  /// The camera's box and full-canvas progress at this instant.
  ///
  /// The first region covering the timestamp wins, matching the compositor --
  /// overlapping regions are the caller's problem either way, and "the first
  /// one" is at least a rule.
  ///
  /// Both ends are inclusive, again matching, so a region ending exactly on a
  /// frame still owns that frame.
  pub fn state_at(&self, timestamp_ms: f64, base: Rect) -> WebcamZoomState {
    for region in &self.regions {
      if timestamp_ms < region.start_ms || timestamp_ms > region.end_ms {
        continue;
      }

      let eased = webcam_ease_at(region, timestamp_ms);

      return WebcamZoomState {
        rect: lerp_rect(base, region.rect, eased),
        // The size eases whether or not this is a full-canvas region; the
        // expansion only does when it is one.
        full_screen: if region.full_screen { eased } else { 0.0 },
      };
    }

    WebcamZoomState {
      rect: base,
      full_screen: 0.0,
    }
  }
}

/// Ease for a webcam region: 0 at the edges, 1 while held.
///
/// The same shape as `ease_at` but against a `WebcamZoomRegion`, and worth
/// keeping separate rather than making both generic -- they are two timelines
/// that happen to share a curve, not one timeline used twice.
fn webcam_ease_at(region: &WebcamZoomRegion, timestamp_ms: f64) -> f32 {
  let ease = region.ease_duration_ms.max(0.0);
  if ease <= 0.0 {
    return 1.0;
  }

  if timestamp_ms < region.start_ms + ease {
    return smoothstep(((timestamp_ms - region.start_ms) / ease) as f32);
  }

  if timestamp_ms > region.end_ms - ease {
    return smoothstep(((region.end_ms - timestamp_ms) / ease) as f32);
  }

  1.0
}

/// Straight-line blend between two rectangles.
pub fn lerp_rect(from: Rect, to: Rect, amount: f32) -> Rect {
  let mix = |a: f32, b: f32| a + (b - a) * amount;
  Rect {
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    width: mix(from.width, to.width),
    height: mix(from.height, to.height),
  }
}

#[cfg(test)]
mod webcam_zoom_tests {
  use super::*;

  const BASE: Rect = Rect {
    x: 100.0,
    y: 100.0,
    width: 200.0,
    height: 100.0,
  };
  const GROWN: Rect = Rect {
    x: 50.0,
    y: 50.0,
    width: 400.0,
    height: 200.0,
  };

  fn region(full_screen: bool, ease_ms: f64) -> WebcamZoomRegion {
    WebcamZoomRegion {
      start_ms: 1000.0,
      end_ms: 3000.0,
      ease_duration_ms: ease_ms,
      rect: GROWN,
      full_screen,
    }
  }

  #[test]
  fn outside_every_region_the_camera_is_where_it_was_laid_out() {
    let track = WebcamZoomTrack::new(vec![region(false, 200.0)]);

    assert_eq!(track.state_at(0.0, BASE).rect, BASE);
    assert_eq!(track.state_at(5000.0, BASE).rect, BASE);
    assert_eq!(track.state_at(0.0, BASE).full_screen, 0.0);
  }

  #[test]
  fn held_in_the_middle_it_is_the_region_s_own_box() {
    let track = WebcamZoomTrack::new(vec![region(false, 200.0)]);
    assert_eq!(track.state_at(2000.0, BASE).rect, GROWN);
  }

  #[test]
  fn the_edges_ease_between_the_two() {
    let track = WebcamZoomTrack::new(vec![region(false, 200.0)]);

    // Halfway through the ease is smoothstep(0.5) = 0.5 exactly.
    let midway = track.state_at(1100.0, BASE).rect;
    assert!((midway.width - 300.0).abs() < 0.01, "width {}", midway.width);
    assert!((midway.x - 75.0).abs() < 0.01, "x {}", midway.x);

    // And it comes back down the other end.
    let leaving = track.state_at(2900.0, BASE).rect;
    assert!((leaving.width - 300.0).abs() < 0.01, "width {}", leaving.width);
  }

  #[test]
  fn both_ends_are_inclusive() {
    // A region ending exactly on a frame still owns that frame, matching the
    // compositor -- otherwise the last frame of a zoom snaps back.
    let track = WebcamZoomTrack::new(vec![region(false, 0.0)]);
    assert_eq!(track.state_at(1000.0, BASE).rect, GROWN);
    assert_eq!(track.state_at(3000.0, BASE).rect, GROWN);
    assert_eq!(track.state_at(3000.1, BASE).rect, BASE);
  }

  #[test]
  fn full_screen_progress_follows_the_same_ease() {
    let track = WebcamZoomTrack::new(vec![region(true, 200.0)]);

    assert_eq!(track.state_at(1000.0, BASE).full_screen, 0.0);
    assert!((track.state_at(1100.0, BASE).full_screen - 0.5).abs() < 0.01);
    assert_eq!(track.state_at(2000.0, BASE).full_screen, 1.0);
  }

  #[test]
  fn a_size_region_does_not_expand_the_camera() {
    // Growing the box and taking over the frame are separate things: a region
    // that only changes the size must not dissolve the corners as well.
    let track = WebcamZoomTrack::new(vec![region(false, 0.0)]);
    assert_eq!(track.state_at(2000.0, BASE).full_screen, 0.0);
  }

  #[test]
  fn no_ease_snaps_straight_to_the_region() {
    let track = WebcamZoomTrack::new(vec![region(true, 0.0)]);
    let state = track.state_at(1000.0, BASE);
    assert_eq!(state.rect, GROWN);
    assert_eq!(state.full_screen, 1.0);
  }

  #[test]
  fn the_first_covering_region_wins() {
    let second = WebcamZoomRegion {
      rect: Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
      },
      ..region(false, 0.0)
    };
    let track = WebcamZoomTrack::new(vec![region(false, 0.0), second]);

    assert_eq!(track.state_at(2000.0, BASE).rect, GROWN);
  }
}

#[cfg(test)]
mod curve_scenarios {
  use super::*;

  #[test]
  fn smoothstep_starts_at_zero() {
    assert_eq!(smoothstep(0.0), 0.0);
  }

  #[test]
  fn smoothstep_ends_at_one() {
    assert_eq!(smoothstep(1.0), 1.0);
  }

  #[test]
  fn smoothstep_passes_through_the_middle() {
    assert!((smoothstep(0.5) - 0.5).abs() < 1e-6);
  }

  #[test]
  fn smoothstep_clamps_below_its_range() {
    assert_eq!(smoothstep(-5.0), 0.0);
  }

  #[test]
  fn smoothstep_clamps_above_its_range() {
    assert_eq!(smoothstep(5.0), 1.0);
  }

  #[test]
  fn smoothstep_is_monotonic() {
    let mut last = -1.0;
    for step in 0..=20 {
      let value = smoothstep(step as f32 / 20.0);
      assert!(value >= last, "step {step}: {value} < {last}");
      last = value;
    }
  }

  #[test]
  fn smoothstep_is_symmetric_about_its_middle() {
    for step in 0..=10 {
      let t = step as f32 / 10.0;
      assert!(
        (smoothstep(t) + smoothstep(1.0 - t) - 1.0).abs() < 1e-5,
        "t {t}"
      );
    }
  }

  #[test]
  fn smoothstep_leaves_and_arrives_flat() {
    // Zero derivative at both ends is the whole point: a linear ramp would
    // start and stop with a visible corner.
    let near_start = smoothstep(0.02) - smoothstep(0.0);
    let near_middle = smoothstep(0.52) - smoothstep(0.5);
    assert!(near_start < near_middle, "{near_start} vs {near_middle}");
    let near_end = smoothstep(1.0) - smoothstep(0.98);
    assert!(near_end < near_middle, "{near_end} vs {near_middle}");
  }

  #[test]
  fn smoothstep_never_leaves_zero_to_one() {
    for step in -10..30 {
      let value = smoothstep(step as f32 / 20.0);
      assert!((0.0..=1.0).contains(&value), "step {step}: {value}");
    }
  }

  #[test]
  fn a_normalised_value_in_range_is_left_alone() {
    for value in [0.0f32, 0.25, 0.5, 1.0] {
      assert_eq!(clamp_normalised(value), value);
    }
  }

  #[test]
  fn a_normalised_value_past_the_edges_is_clamped() {
    assert_eq!(clamp_normalised(-3.0), 0.0);
    assert_eq!(clamp_normalised(9.0), 1.0);
  }

  #[test]
  fn a_non_finite_normalised_value_falls_back_to_zero() {
    // Not clamped: NaN clamps to NaN, which would then be a pivot the render
    // pass could not draw around.
    assert_eq!(clamp_normalised(f32::NAN), 0.0);
    assert_eq!(clamp_normalised(f32::INFINITY), 0.0);
    assert_eq!(clamp_normalised(f32::NEG_INFINITY), 0.0);
  }

  #[test]
  fn lerping_at_zero_is_the_start() {
    let from = Rect {
      x: 1.0,
      y: 2.0,
      width: 3.0,
      height: 4.0,
    };
    let to = Rect {
      x: 9.0,
      y: 8.0,
      width: 7.0,
      height: 6.0,
    };
    assert_eq!(lerp_rect(from, to, 0.0), from);
  }

  #[test]
  fn lerping_at_one_is_the_end() {
    let from = Rect {
      x: 1.0,
      y: 2.0,
      width: 3.0,
      height: 4.0,
    };
    let to = Rect {
      x: 9.0,
      y: 8.0,
      width: 7.0,
      height: 6.0,
    };
    assert_eq!(lerp_rect(from, to, 1.0), to);
  }

  #[test]
  fn lerping_halfway_is_the_midpoint_of_every_field() {
    let from = Rect {
      x: 0.0,
      y: 0.0,
      width: 100.0,
      height: 200.0,
    };
    let to = Rect {
      x: 100.0,
      y: 50.0,
      width: 300.0,
      height: 400.0,
    };
    assert_eq!(
      lerp_rect(from, to, 0.5),
      Rect {
        x: 50.0,
        y: 25.0,
        width: 200.0,
        height: 300.0,
      }
    );
  }

  #[test]
  fn lerping_between_a_rect_and_itself_changes_nothing() {
    let same = Rect {
      x: 5.0,
      y: 6.0,
      width: 7.0,
      height: 8.0,
    };
    for amount in [0.0f32, 0.3, 0.7, 1.0] {
      assert_eq!(lerp_rect(same, same, amount), same);
    }
  }

  #[test]
  fn lerping_is_linear_in_the_amount() {
    let from = Rect {
      x: 0.0,
      y: 0.0,
      width: 100.0,
      height: 100.0,
    };
    let to = Rect {
      x: 400.0,
      y: 0.0,
      width: 100.0,
      height: 100.0,
    };
    let step_low = lerp_rect(from, to, 0.2).x - lerp_rect(from, to, 0.1).x;
    let step_high = lerp_rect(from, to, 0.9).x - lerp_rect(from, to, 0.8).x;
    assert!((step_low - step_high).abs() < 1e-3);
  }
}

#[cfg(test)]
mod zoom_state_scenarios {
  use super::*;

  fn rect() -> Rect {
    Rect {
      x: 100.0,
      y: 50.0,
      width: 800.0,
      height: 450.0,
    }
  }

  #[test]
  fn the_default_zoom_is_no_zoom() {
    assert!(ZoomState::default().is_identity());
    assert_eq!(ZoomState::default().scale, 1.0);
  }

  #[test]
  fn a_scale_of_exactly_one_is_the_identity() {
    let state = ZoomState {
      scale: 1.0,
      pivot_x: 400.0,
      pivot_y: 300.0,
    };
    assert!(state.is_identity());
  }

  #[test]
  fn a_scale_a_hair_off_one_is_still_treated_as_the_identity() {
    // The tolerance exists so an ease that has arithmetically not quite
    // returned to 1 does not cost a transform every frame.
    let state = ZoomState {
      scale: 1.0 + 1e-9,
      pivot_x: 0.0,
      pivot_y: 0.0,
    };
    assert!(state.is_identity());
  }

  #[test]
  fn a_real_zoom_is_not_the_identity() {
    for scale in [1.01f32, 1.5, 2.0, 4.0, 0.5] {
      let state = ZoomState {
        scale,
        pivot_x: 0.0,
        pivot_y: 0.0,
      };
      assert!(!state.is_identity(), "{scale}");
    }
  }

  #[test]
  fn the_identity_returns_the_rect_untouched() {
    let state = ZoomState::default();
    assert_eq!(state.apply(rect()), rect());
  }

  #[test]
  fn a_zoom_scales_the_size_by_the_scale() {
    let state = ZoomState {
      scale: 2.0,
      pivot_x: 0.0,
      pivot_y: 0.0,
    };
    let out = state.apply(rect());
    assert_eq!(out.width, 1600.0);
    assert_eq!(out.height, 900.0);
  }

  #[test]
  fn a_zoom_leaves_the_pivot_exactly_where_it_was() {
    // The property that makes this a zoom rather than a move.
    for (px, py) in [(500.0f32, 275.0f32), (100.0, 50.0), (900.0, 500.0)] {
      let state = ZoomState {
        scale: 3.0,
        pivot_x: px,
        pivot_y: py,
      };
      let out = state.apply(rect());
      let before = ((px - rect().x) / rect().width, (py - rect().y) / rect().height);
      let after = ((px - out.x) / out.width, (py - out.y) / out.height);
      assert!((before.0 - after.0).abs() < 1e-4, "{px},{py}");
      assert!((before.1 - after.1).abs() < 1e-4, "{px},{py}");
    }
  }

  #[test]
  fn a_pivot_on_the_top_left_corner_pins_that_corner() {
    let state = ZoomState {
      scale: 2.0,
      pivot_x: rect().x,
      pivot_y: rect().y,
    };
    let out = state.apply(rect());
    assert_eq!(out.x, rect().x);
    assert_eq!(out.y, rect().y);
  }

  #[test]
  fn a_pivot_in_the_middle_grows_the_rect_evenly_around_it() {
    let centre = (rect().x + rect().width * 0.5, rect().y + rect().height * 0.5);
    let state = ZoomState {
      scale: 2.0,
      pivot_x: centre.0,
      pivot_y: centre.1,
    };
    let out = state.apply(rect());
    let left = centre.0 - out.x;
    let right = (out.x + out.width) - centre.0;
    assert!((left - right).abs() < 1e-3);
  }

  #[test]
  fn a_scale_below_one_shrinks_rather_than_failing() {
    let state = ZoomState {
      scale: 0.5,
      pivot_x: 500.0,
      pivot_y: 275.0,
    };
    let out = state.apply(rect());
    assert_eq!(out.width, 400.0);
    assert_eq!(out.height, 225.0);
  }

  #[test]
  fn applying_a_zoom_and_its_inverse_returns_the_rect() {
    let zoom_in = ZoomState {
      scale: 2.0,
      pivot_x: 500.0,
      pivot_y: 275.0,
    };
    let zoom_out = ZoomState {
      scale: 0.5,
      pivot_x: 500.0,
      pivot_y: 275.0,
    };
    let round_trip = zoom_out.apply(zoom_in.apply(rect()));
    assert!((round_trip.x - rect().x).abs() < 1e-3);
    assert!((round_trip.width - rect().width).abs() < 1e-3);
  }

  #[test]
  fn every_layer_scaled_about_the_same_pivot_keeps_its_relative_position() {
    // The reason the engine needs no transform stack: two rects put through the
    // same ZoomState stay in the same arrangement as each other.
    let state = ZoomState {
      scale: 2.5,
      pivot_x: 300.0,
      pivot_y: 200.0,
    };
    let a = rect();
    let b = Rect {
      x: 200.0,
      y: 100.0,
      width: 80.0,
      height: 45.0,
    };
    let gap_before = b.x - a.x;
    let gap_after = state.apply(b).x - state.apply(a).x;
    assert!((gap_after - gap_before * 2.5).abs() < 1e-3);
  }

  #[test]
  fn an_empty_rect_stays_empty_under_a_zoom() {
    let state = ZoomState {
      scale: 3.0,
      pivot_x: 0.0,
      pivot_y: 0.0,
    };
    let empty = Rect {
      x: 10.0,
      y: 10.0,
      width: 0.0,
      height: 0.0,
    };
    assert!(state.apply(empty).is_empty());
  }
}

#[cfg(test)]
mod zoom_track_scenarios {
  use super::*;

  fn video() -> Rect {
    Rect {
      x: 100.0,
      y: 50.0,
      width: 800.0,
      height: 450.0,
    }
  }

  fn region(start_ms: f64, end_ms: f64, level: f32) -> ZoomRegion {
    ZoomRegion {
      start_ms,
      end_ms,
      level,
      focal_x: 0.5,
      focal_y: 0.5,
      ease_duration_ms: 200.0,
      focal_keyframes: Vec::new(),
    }
  }

  #[test]
  fn an_empty_track_reports_itself_empty() {
    let track = ZoomTrack::new(Vec::new());
    assert!(track.is_empty());
    assert_eq!(track.len(), 0);
  }

  #[test]
  fn the_default_track_is_empty() {
    assert!(ZoomTrack::default().is_empty());
  }

  #[test]
  fn a_track_reports_how_many_regions_it_holds() {
    let track = ZoomTrack::new(vec![region(0.0, 1000.0, 2.0), region(2000.0, 3000.0, 2.0)]);
    assert_eq!(track.len(), 2);
    assert!(!track.is_empty());
  }

  #[test]
  fn an_empty_track_never_zooms() {
    let track = ZoomTrack::new(Vec::new());
    for t in [0.0, 1000.0, 1e9] {
      assert!(track.state_at(t, video()).is_identity(), "{t}");
    }
  }

  #[test]
  fn an_empty_track_still_reports_the_middle_of_the_video_as_the_pivot() {
    // Not the middle of the canvas: a pivot that only becomes correct once a
    // region starts would make the first frame of a zoom jump.
    let state = ZoomTrack::new(Vec::new()).state_at(0.0, video());
    assert_eq!(state.pivot_x, 500.0);
    assert_eq!(state.pivot_y, 275.0);
  }

  #[test]
  fn before_a_region_there_is_no_zoom() {
    let track = ZoomTrack::new(vec![region(1000.0, 3000.0, 2.0)]);
    assert!(track.state_at(500.0, video()).is_identity());
  }

  #[test]
  fn after_a_region_there_is_no_zoom() {
    let track = ZoomTrack::new(vec![region(1000.0, 3000.0, 2.0)]);
    assert!(track.state_at(4000.0, video()).is_identity());
  }

  #[test]
  fn between_two_regions_there_is_no_zoom() {
    let track = ZoomTrack::new(vec![region(0.0, 1000.0, 2.0), region(2000.0, 3000.0, 2.0)]);
    assert!(track.state_at(1500.0, video()).is_identity());
  }

  #[test]
  fn the_held_middle_of_a_region_is_at_the_full_level() {
    let track = ZoomTrack::new(vec![region(1000.0, 3000.0, 2.5)]);
    assert!((track.state_at(2000.0, video()).scale - 2.5).abs() < 1e-5);
  }

  #[test]
  fn a_region_holds_its_level_across_the_whole_middle() {
    let track = ZoomTrack::new(vec![region(1000.0, 3000.0, 2.0)]);
    for t in [1200.0, 1500.0, 2000.0, 2500.0, 2800.0] {
      assert!((track.state_at(t, video()).scale - 2.0).abs() < 1e-5, "{t}");
    }
  }

  #[test]
  fn the_ease_in_climbs_from_nothing_to_the_level() {
    let track = ZoomTrack::new(vec![region(1000.0, 3000.0, 2.0)]);
    let mut last = 0.0;
    for step in 0..=10 {
      let t = 1000.0 + 200.0 * (step as f64 / 10.0);
      let scale = track.state_at(t, video()).scale;
      assert!(scale >= last - 1e-6, "at {t}: {scale} < {last}");
      last = scale;
    }
    assert!((last - 2.0).abs() < 1e-5);
  }

  #[test]
  fn the_ease_out_falls_from_the_level_back_to_nothing() {
    let track = ZoomTrack::new(vec![region(1000.0, 3000.0, 2.0)]);
    let mut last = 3.0;
    for step in 0..=10 {
      let t = 2800.0 + 200.0 * (step as f64 / 10.0);
      let scale = track.state_at(t, video()).scale;
      assert!(scale <= last + 1e-6, "at {t}: {scale} > {last}");
      last = scale;
    }
    assert!((last - 1.0).abs() < 1e-5);
  }

  #[test]
  fn a_region_with_no_ease_snaps_straight_to_its_level() {
    let mut r = region(1000.0, 3000.0, 2.0);
    r.ease_duration_ms = 0.0;
    let track = ZoomTrack::new(vec![r]);
    assert_eq!(track.state_at(1000.0, video()).scale, 2.0);
    assert_eq!(track.state_at(3000.0, video()).scale, 2.0);
  }

  #[test]
  fn a_negative_ease_is_treated_as_none() {
    let mut r = region(1000.0, 3000.0, 2.0);
    r.ease_duration_ms = -400.0;
    let track = ZoomTrack::new(vec![r]);
    assert_eq!(track.state_at(1000.0, video()).scale, 2.0);
  }

  #[test]
  fn a_level_of_one_is_a_region_that_does_nothing() {
    let track = ZoomTrack::new(vec![region(1000.0, 3000.0, 1.0)]);
    assert!(track.state_at(2000.0, video()).is_identity());
  }

  #[test]
  fn a_level_below_one_zooms_out() {
    let track = ZoomTrack::new(vec![region(1000.0, 3000.0, 0.5)]);
    assert!((track.state_at(2000.0, video()).scale - 0.5).abs() < 1e-5);
  }

  #[test]
  fn a_zoom_out_still_eases_from_no_zoom() {
    let track = ZoomTrack::new(vec![region(1000.0, 3000.0, 0.5)]);
    assert!((track.state_at(1000.0, video()).scale - 1.0).abs() < 1e-5);
    assert!(track.state_at(1100.0, video()).scale < 1.0);
  }

  #[test]
  fn the_scale_moves_between_one_and_the_level_and_nowhere_else() {
    let track = ZoomTrack::new(vec![region(1000.0, 3000.0, 3.0)]);
    for step in 0..=100 {
      let t = 1000.0 + 20.0 * step as f64;
      let scale = track.state_at(t, video()).scale;
      assert!((1.0..=3.0).contains(&scale), "at {t}: {scale}");
    }
  }

  #[test]
  fn regions_are_sorted_so_the_earliest_start_wins() {
    // Overlapping regions are the caller's problem, but "the one that starts
    // first" is at least a rule rather than arrival order.
    let track = ZoomTrack::new(vec![region(2000.0, 4000.0, 3.0), region(1000.0, 5000.0, 2.0)]);
    let mut early = region(1000.0, 5000.0, 2.0);
    early.ease_duration_ms = 200.0;
    let _ = early;
    // At 3000 both cover it; the one starting at 1000 owns it.
    assert!((track.state_at(3000.0, video()).scale - 2.0).abs() < 1e-5);
  }

  #[test]
  fn a_region_outside_the_earliest_ones_span_still_gets_its_turn() {
    let track = ZoomTrack::new(vec![region(4000.0, 5000.0, 3.0), region(0.0, 1000.0, 2.0)]);
    assert!((track.state_at(4500.0, video()).scale - 3.0).abs() < 1e-5);
    assert!((track.state_at(500.0, video()).scale - 2.0).abs() < 1e-5);
  }

  #[test]
  fn many_regions_each_own_their_own_span() {
    let regions: Vec<ZoomRegion> = (0..5)
      .map(|i| region(i as f64 * 1000.0, i as f64 * 1000.0 + 500.0, 1.5 + i as f32))
      .collect();
    let track = ZoomTrack::new(regions);
    for i in 0..5 {
      let middle = i as f64 * 1000.0 + 250.0;
      let scale = track.state_at(middle, video()).scale;
      assert!((scale - (1.5 + i as f32)).abs() < 1e-4, "region {i}: {scale}");
      // And the gap after it is unzoomed.
      assert!(track.state_at(i as f64 * 1000.0 + 750.0, video()).is_identity());
    }
  }

  #[test]
  fn the_pivot_maps_through_where_the_video_sits() {
    // Focal points are authored against the recording, so a zoom lands off by
    // the padding if it is resolved against the canvas instead.
    let mut r = region(1000.0, 3000.0, 2.0);
    r.focal_x = 0.0;
    r.focal_y = 0.0;
    let track = ZoomTrack::new(vec![r]);
    let state = track.state_at(2000.0, video());
    assert_eq!(state.pivot_x, 100.0);
    assert_eq!(state.pivot_y, 50.0);
  }

  #[test]
  fn a_focal_point_at_the_far_corner_maps_to_the_videos_far_corner() {
    let mut r = region(1000.0, 3000.0, 2.0);
    r.focal_x = 1.0;
    r.focal_y = 1.0;
    let track = ZoomTrack::new(vec![r]);
    let state = track.state_at(2000.0, video());
    assert_eq!(state.pivot_x, 900.0);
    assert_eq!(state.pivot_y, 500.0);
  }

  #[test]
  fn a_focal_point_outside_the_recording_is_pulled_back_onto_it() {
    let mut r = region(1000.0, 3000.0, 2.0);
    r.focal_x = 4.0;
    r.focal_y = -2.0;
    let track = ZoomTrack::new(vec![r]);
    let state = track.state_at(2000.0, video());
    assert_eq!(state.pivot_x, 900.0);
    assert_eq!(state.pivot_y, 50.0);
  }

  #[test]
  fn a_non_finite_focal_point_falls_back_to_the_videos_corner() {
    let mut r = region(1000.0, 3000.0, 2.0);
    r.focal_x = f32::NAN;
    r.focal_y = f32::INFINITY;
    let track = ZoomTrack::new(vec![r]);
    let state = track.state_at(2000.0, video());
    assert!(state.pivot_x.is_finite() && state.pivot_y.is_finite());
    assert_eq!(state.pivot_x, 100.0);
    assert_eq!(state.pivot_y, 50.0);
  }

  #[test]
  fn the_pivot_follows_the_video_when_the_video_moves() {
    let mut r = region(1000.0, 3000.0, 2.0);
    r.focal_x = 0.25;
    r.focal_y = 0.5;
    let track = ZoomTrack::new(vec![r]);
    let moved = Rect {
      x: 500.0,
      y: 300.0,
      width: 400.0,
      height: 225.0,
    };
    let state = track.state_at(2000.0, moved);
    assert_eq!(state.pivot_x, 500.0 + 100.0);
    assert_eq!(state.pivot_y, 300.0 + 112.5);
  }

  #[test]
  fn the_pivot_holds_still_while_the_scale_eases() {
    // No keyframes means no pan, so only one of the two numbers moves.
    let track = ZoomTrack::new(vec![region(1000.0, 3000.0, 2.0)]);
    let early = track.state_at(1050.0, video());
    let held = track.state_at(2000.0, video());
    assert_eq!(early.pivot_x, held.pivot_x);
    assert_eq!(early.pivot_y, held.pivot_y);
    assert!(early.scale < held.scale);
  }

  #[test]
  fn a_region_owns_both_of_its_endpoints() {
    let track = ZoomTrack::new(vec![region(1000.0, 3000.0, 2.0)]);
    // The scale is back to 1 at both, but the region is what answered -- which
    // shows in the pivot when the focal point is not the centre.
    let mut off_centre = region(1000.0, 3000.0, 2.0);
    off_centre.focal_x = 0.0;
    let track_off = ZoomTrack::new(vec![off_centre]);
    assert_eq!(track_off.state_at(1000.0, video()).pivot_x, 100.0);
    assert_eq!(track_off.state_at(3000.0, video()).pivot_x, 100.0);
    assert!(track.state_at(1000.0, video()).scale.is_finite());
  }

  #[test]
  fn a_region_of_no_length_does_not_crash_the_ease() {
    let mut r = region(1000.0, 1000.0, 2.0);
    r.ease_duration_ms = 200.0;
    let track = ZoomTrack::new(vec![r]);
    assert!(track.state_at(1000.0, video()).scale.is_finite());
  }

  #[test]
  fn an_ease_longer_than_the_region_never_reaches_the_full_level() {
    let mut r = region(1000.0, 1400.0, 4.0);
    r.ease_duration_ms = 1000.0;
    let track = ZoomTrack::new(vec![r]);
    let peak = (0..=40)
      .map(|s| track.state_at(1000.0 + 10.0 * s as f64, video()).scale)
      .fold(0.0f32, f32::max);
    assert!(peak < 4.0, "{peak}");
    assert!(peak > 1.0, "{peak}");
  }

  #[test]
  fn an_ease_longer_than_the_region_never_gets_to_ease_out() {
    // The in-ramp is tested first, so when it covers the whole region it wins
    // for every frame: the zoom starts from nothing and then stops partway up
    // rather than coming back down. Worth pinning -- it is the behaviour a
    // caller sees if the editor ever lets an ease exceed half the span.
    let mut r = region(1000.0, 1400.0, 4.0);
    r.ease_duration_ms = 1000.0;
    let track = ZoomTrack::new(vec![r]);
    assert!((track.state_at(1000.0, video()).scale - 1.0).abs() < 1e-5);
    let ending = track.state_at(1400.0, video()).scale;
    assert!(ending > 1.0, "{ending}");
    // And the very next instant is outside the region, so it snaps back.
    assert!(track.state_at(1400.1, video()).is_identity());
  }
}

#[cfg(test)]
mod focal_pan_scenarios {
  use super::*;

  fn video() -> Rect {
    Rect {
      x: 0.0,
      y: 0.0,
      width: 1000.0,
      height: 1000.0,
    }
  }

  fn key(timestamp_ms: f64, x: f32, y: f32) -> FocalKeyframe {
    FocalKeyframe {
      timestamp_ms,
      x,
      y,
    }
  }

  fn panning(keyframes: Vec<FocalKeyframe>) -> ZoomRegion {
    ZoomRegion {
      start_ms: 1000.0,
      end_ms: 3000.0,
      level: 2.0,
      focal_x: 0.0,
      focal_y: 0.0,
      ease_duration_ms: 0.0,
      focal_keyframes: keyframes,
    }
  }

  #[test]
  fn with_no_keyframes_the_zoom_holds_its_own_focal_point() {
    let track = ZoomTrack::new(vec![panning(Vec::new())]);
    for t in [1000.0, 2000.0, 3000.0] {
      assert_eq!(track.state_at(t, video()).pivot_x, 0.0, "{t}");
    }
  }

  #[test]
  fn the_regions_own_focal_point_is_the_first_keyframe() {
    // Which is why a single extra keyframe produces a pan rather than a jump.
    let track = ZoomTrack::new(vec![panning(vec![key(3000.0, 1.0, 1.0)])]);
    assert_eq!(track.state_at(1000.0, video()).pivot_x, 0.0);
  }

  #[test]
  fn a_pan_arrives_at_its_last_keyframe() {
    let track = ZoomTrack::new(vec![panning(vec![key(3000.0, 1.0, 1.0)])]);
    assert_eq!(track.state_at(3000.0, video()).pivot_x, 1000.0);
    assert_eq!(track.state_at(3000.0, video()).pivot_y, 1000.0);
  }

  #[test]
  fn a_pan_is_halfway_across_at_the_halfway_point() {
    let track = ZoomTrack::new(vec![panning(vec![key(3000.0, 1.0, 1.0)])]);
    let state = track.state_at(2000.0, video());
    assert!((state.pivot_x - 500.0).abs() < 1e-3, "{}", state.pivot_x);
    assert!((state.pivot_y - 500.0).abs() < 1e-3, "{}", state.pivot_y);
  }

  #[test]
  fn a_pan_moves_in_a_straight_line_rather_than_easing_at_each_stop() {
    // Easing at every keyframe would make a long move stutter its way across.
    let track = ZoomTrack::new(vec![panning(vec![key(3000.0, 1.0, 0.0)])]);
    let at = |t: f64| track.state_at(t, video()).pivot_x;
    let step_early = at(1400.0) - at(1200.0);
    let step_late = at(2800.0) - at(2600.0);
    assert!((step_early - step_late).abs() < 1e-2);
  }

  #[test]
  fn a_pan_holds_at_its_first_keyframe_before_it_starts() {
    let track = ZoomTrack::new(vec![panning(vec![key(2000.0, 1.0, 0.0)])]);
    assert_eq!(track.state_at(1000.0, video()).pivot_x, 0.0);
  }

  #[test]
  fn a_pan_holds_at_its_last_keyframe_after_it_ends() {
    let track = ZoomTrack::new(vec![panning(vec![key(2000.0, 1.0, 0.0)])]);
    assert_eq!(track.state_at(2500.0, video()).pivot_x, 1000.0);
    assert_eq!(track.state_at(3000.0, video()).pivot_x, 1000.0);
  }

  #[test]
  fn a_pan_through_three_points_visits_each_of_them() {
    let track = ZoomTrack::new(vec![panning(vec![
      key(2000.0, 1.0, 0.0),
      key(3000.0, 0.0, 1.0),
    ])]);
    assert_eq!(track.state_at(1000.0, video()).pivot_x, 0.0);
    assert!((track.state_at(2000.0, video()).pivot_x - 1000.0).abs() < 1e-3);
    assert!((track.state_at(3000.0, video()).pivot_x - 0.0).abs() < 1e-3);
    assert!((track.state_at(3000.0, video()).pivot_y - 1000.0).abs() < 1e-3);
  }

  #[test]
  fn a_pan_changes_direction_at_a_keyframe_rather_than_smoothing_through_it() {
    let track = ZoomTrack::new(vec![panning(vec![
      key(2000.0, 1.0, 0.0),
      key(3000.0, 0.0, 0.0),
    ])]);
    let at = |t: f64| track.state_at(t, video()).pivot_x;
    assert!(at(1900.0) > at(1800.0));
    assert!(at(2100.0) < at(2000.0));
  }

  #[test]
  fn keyframes_arriving_out_of_order_are_sorted() {
    let track = ZoomTrack::new(vec![panning(vec![
      key(3000.0, 0.0, 0.0),
      key(2000.0, 1.0, 0.0),
    ])]);
    assert!((track.state_at(2000.0, video()).pivot_x - 1000.0).abs() < 1e-3);
  }

  #[test]
  fn a_keyframe_outside_the_normalised_range_is_pulled_back_in() {
    let track = ZoomTrack::new(vec![panning(vec![key(3000.0, 5.0, -5.0)])]);
    let state = track.state_at(3000.0, video());
    assert_eq!(state.pivot_x, 1000.0);
    assert_eq!(state.pivot_y, 0.0);
  }

  #[test]
  fn a_non_finite_keyframe_becomes_the_recordings_corner_rather_than_a_nan_pivot() {
    let track = ZoomTrack::new(vec![panning(vec![key(3000.0, f32::NAN, f32::NAN)])]);
    let state = track.state_at(3000.0, video());
    assert!(state.pivot_x.is_finite() && state.pivot_y.is_finite());
    assert_eq!(state.pivot_x, 0.0);
  }

  #[test]
  fn two_keyframes_at_the_same_instant_do_not_divide_by_zero() {
    let track = ZoomTrack::new(vec![panning(vec![
      key(2000.0, 1.0, 0.0),
      key(2000.0, 0.0, 1.0),
    ])]);
    for t in [1500.0, 2000.0, 2500.0] {
      let state = track.state_at(t, video());
      assert!(state.pivot_x.is_finite() && state.pivot_y.is_finite(), "{t}");
    }
  }

  #[test]
  fn a_keyframe_before_the_regions_start_is_already_behind_the_pan() {
    // The sorted list runs [500 -> (1,0), 1000 -> (0,0)], and the region only
    // answers from 1000 onwards -- by which point the pan has passed its last
    // point. So a keyframe authored before the region has no visible effect
    // rather than dragging the pivot backwards into the ease.
    let track = ZoomTrack::new(vec![panning(vec![key(500.0, 1.0, 0.0)])]);
    for t in [1000.0, 2000.0, 3000.0] {
      assert!((track.state_at(t, video()).pivot_x - 0.0).abs() < 1e-3, "{t}");
    }
    // And outside the region there is no zoom at all, focal points or not.
    assert!(track.state_at(400.0, video()).is_identity());
  }

  #[test]
  fn the_pan_never_leaves_the_recording() {
    let track = ZoomTrack::new(vec![panning(vec![
      key(1500.0, 1.0, 1.0),
      key(2000.0, 0.0, 1.0),
      key(2500.0, 1.0, 0.0),
      key(3000.0, 0.0, 0.0),
    ])]);
    for step in 0..=40 {
      let t = 1000.0 + 50.0 * step as f64;
      let state = track.state_at(t, video());
      assert!((0.0..=1000.0).contains(&state.pivot_x), "at {t}");
      assert!((0.0..=1000.0).contains(&state.pivot_y), "at {t}");
    }
  }

  #[test]
  fn panning_and_easing_happen_at_the_same_time_without_interfering() {
    let mut r = panning(vec![key(3000.0, 1.0, 0.0)]);
    r.ease_duration_ms = 400.0;
    let track = ZoomTrack::new(vec![r]);
    // Partway into the ease-in the scale is still climbing, and the pan has
    // already started moving.
    let state = track.state_at(1200.0, video());
    assert!(state.scale > 1.0 && state.scale < 2.0, "{}", state.scale);
    assert!(state.pivot_x > 0.0 && state.pivot_x < 1000.0, "{}", state.pivot_x);
  }

  #[test]
  fn a_pan_is_continuous_across_every_keyframe() {
    let track = ZoomTrack::new(vec![panning(vec![
      key(1500.0, 0.5, 0.0),
      key(2000.0, 0.5, 0.5),
      key(2500.0, 0.0, 0.5),
    ])]);
    let at = |t: f64| track.state_at(t, video()).pivot_x;
    for boundary in [1500.0, 2000.0, 2500.0] {
      let before = at(boundary - 1.0);
      let after = at(boundary + 1.0);
      assert!((before - after).abs() < 10.0, "at {boundary}: {before} {after}");
    }
  }
}

#[cfg(test)]
mod webcam_zoom_scenarios {
  use super::*;

  const BASE: Rect = Rect {
    x: 1400.0,
    y: 800.0,
    width: 400.0,
    height: 225.0,
  };
  const GROWN: Rect = Rect {
    x: 200.0,
    y: 100.0,
    width: 1200.0,
    height: 675.0,
  };

  fn region(start_ms: f64, end_ms: f64, ease_ms: f64, full_screen: bool) -> WebcamZoomRegion {
    WebcamZoomRegion {
      start_ms,
      end_ms,
      ease_duration_ms: ease_ms,
      rect: GROWN,
      full_screen,
    }
  }

  #[test]
  fn an_empty_track_reports_itself_empty() {
    assert!(WebcamZoomTrack::new(Vec::new()).is_empty());
    assert!(WebcamZoomTrack::default().is_empty());
  }

  #[test]
  fn an_empty_track_leaves_the_camera_where_it_was_laid_out() {
    let track = WebcamZoomTrack::new(Vec::new());
    let state = track.state_at(1234.0, BASE);
    assert_eq!(state.rect, BASE);
    assert_eq!(state.full_screen, 0.0);
  }

  #[test]
  fn outside_every_region_the_camera_is_where_it_was_laid_out() {
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 200.0, false)]);
    assert_eq!(track.state_at(0.0, BASE).rect, BASE);
    assert_eq!(track.state_at(9000.0, BASE).rect, BASE);
  }

  #[test]
  fn held_in_the_middle_the_camera_is_the_regions_own_box() {
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 200.0, false)]);
    assert_eq!(track.state_at(2000.0, BASE).rect, GROWN);
  }

  #[test]
  fn the_engine_interpolates_the_laid_out_box_rather_than_recomputing_one() {
    // The placement formula -- anchor grid, margin, aspect fit -- lives on the
    // JS side on purpose. A second copy here is how the camera ends up a
    // different size in the preview than in the export.
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 200.0, false)]);
    let midway = track.state_at(1100.0, BASE).rect;
    let expected = lerp_rect(BASE, GROWN, 0.5);
    assert!((midway.x - expected.x).abs() < 0.01, "{}", midway.x);
    assert!((midway.width - expected.width).abs() < 0.01, "{}", midway.width);
  }

  #[test]
  fn both_endpoints_belong_to_the_region() {
    // Inclusive, matching the compositor, so a region ending exactly on a frame
    // still owns that frame.
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 0.0, true)]);
    assert_eq!(track.state_at(1000.0, BASE).rect, GROWN);
    assert_eq!(track.state_at(3000.0, BASE).rect, GROWN);
    assert_eq!(track.state_at(3000.1, BASE).rect, BASE);
  }

  #[test]
  fn a_region_with_no_ease_snaps_to_its_box() {
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 0.0, false)]);
    assert_eq!(track.state_at(1000.0, BASE).rect, GROWN);
  }

  #[test]
  fn a_negative_ease_is_treated_as_none() {
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, -100.0, false)]);
    assert_eq!(track.state_at(1000.0, BASE).rect, GROWN);
  }

  #[test]
  fn the_ease_in_moves_the_box_from_one_to_the_other() {
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 200.0, false)]);
    let mut last = BASE.width;
    for step in 0..=10 {
      let t = 1000.0 + 200.0 * (step as f64 / 10.0);
      let width = track.state_at(t, BASE).rect.width;
      assert!(width >= last - 1e-3, "at {t}: {width} < {last}");
      last = width;
    }
    assert!((last - GROWN.width).abs() < 1e-2);
  }

  #[test]
  fn the_ease_out_brings_it_back() {
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 200.0, false)]);
    assert!((track.state_at(3000.0, BASE).rect.width - BASE.width).abs() < 1e-2);
  }

  #[test]
  fn an_ordinary_region_never_reports_any_full_screen_progress() {
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 200.0, false)]);
    for t in [1000.0, 1100.0, 2000.0, 2900.0, 3000.0] {
      assert_eq!(track.state_at(t, BASE).full_screen, 0.0, "{t}");
    }
  }

  #[test]
  fn a_full_screen_region_reports_full_progress_while_it_is_held() {
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 200.0, true)]);
    assert_eq!(track.state_at(2000.0, BASE).full_screen, 1.0);
  }

  #[test]
  fn a_full_screen_region_dissolves_in_step_with_the_box() {
    // The radius, border and shape fade out over the same curve the box grows
    // on, so the camera does not pop square at the end of the move.
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 200.0, true)]);
    let state = track.state_at(1100.0, BASE);
    assert!((state.full_screen - 0.5).abs() < 1e-3, "{}", state.full_screen);
    let expected = lerp_rect(BASE, GROWN, 0.5);
    assert!((state.rect.width - expected.width).abs() < 0.01);
  }

  #[test]
  fn full_screen_progress_stays_between_zero_and_one() {
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 400.0, true)]);
    for step in 0..=40 {
      let t = 900.0 + 55.0 * step as f64;
      let value = track.state_at(t, BASE).full_screen;
      assert!((0.0..=1.0).contains(&value), "at {t}: {value}");
    }
  }

  #[test]
  fn the_first_region_covering_an_instant_wins() {
    // Unlike the zoom track, these are not sorted -- the caller's order is the
    // rule, which matters when two regions overlap.
    let first = WebcamZoomRegion {
      rect: Rect {
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 100.0,
      },
      ..region(1000.0, 3000.0, 0.0, false)
    };
    let second = region(1000.0, 3000.0, 0.0, false);
    let track = WebcamZoomTrack::new(vec![first, second]);
    assert_eq!(track.state_at(2000.0, BASE).rect.width, 100.0);
  }

  #[test]
  fn a_later_region_still_answers_for_its_own_span() {
    let track = WebcamZoomTrack::new(vec![
      region(4000.0, 5000.0, 0.0, false),
      region(1000.0, 2000.0, 0.0, true),
    ]);
    assert_eq!(track.state_at(1500.0, BASE).full_screen, 1.0);
    assert_eq!(track.state_at(4500.0, BASE).full_screen, 0.0);
    assert_eq!(track.state_at(4500.0, BASE).rect, GROWN);
  }

  #[test]
  fn the_camera_returns_to_wherever_it_is_currently_laid_out() {
    // The base is passed in per frame rather than captured, so moving the
    // camera in the editor takes effect outside the regions immediately.
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 200.0, false)]);
    let moved = Rect {
      x: 10.0,
      y: 10.0,
      width: 50.0,
      height: 50.0,
    };
    assert_eq!(track.state_at(500.0, moved).rect, moved);
  }

  #[test]
  fn the_ease_starts_from_wherever_the_camera_currently_is() {
    let track = WebcamZoomTrack::new(vec![region(1000.0, 3000.0, 200.0, false)]);
    let moved = Rect {
      x: 10.0,
      y: 10.0,
      width: 50.0,
      height: 50.0,
    };
    assert_eq!(track.state_at(1000.0, moved).rect, moved);
  }

  #[test]
  fn a_region_of_no_length_stays_finite() {
    let track = WebcamZoomTrack::new(vec![region(1000.0, 1000.0, 200.0, true)]);
    let state = track.state_at(1000.0, BASE);
    assert!(state.rect.width.is_finite());
    assert!(state.full_screen.is_finite());
  }

  #[test]
  fn an_ease_longer_than_the_region_never_fully_arrives() {
    let track = WebcamZoomTrack::new(vec![region(1000.0, 1400.0, 2000.0, true)]);
    let peak = (0..=40)
      .map(|s| track.state_at(1000.0 + 10.0 * s as f64, BASE).full_screen)
      .fold(0.0f32, f32::max);
    assert!(peak < 1.0, "{peak}");
    assert!(peak > 0.0, "{peak}");
  }
}
