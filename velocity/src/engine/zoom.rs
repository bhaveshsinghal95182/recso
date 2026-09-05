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

use crate::engine::composite::Rect;

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
