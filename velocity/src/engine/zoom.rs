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
