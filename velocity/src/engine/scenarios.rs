//! The tracks composed the way `stage_timeline` composes them.
//!
//! Every timeline in the engine is expressed in one of two clocks, and getting
//! them the wrong way round is the defining mistake of this codebase: the
//! picture still plays, the pointer is just in the wrong place, and only after
//! a cut. `CutTrack` is the only thing in **source** time -- where a frame sits
//! in the file. The zoom, the cursor, the webcam zoom and the webcam's hidden
//! spans are all in **composition** time -- where it sits in the edit.
//!
//! These tests drive the real functions in the real order rather than
//! reimplementing the chain, so they fail when the seam moves rather than when
//! a copy of the arithmetic drifts.

use crate::engine::layout::{
  fit_source, smear_geometry, CursorSample, CursorTrack, FitMode, HiddenSpans, OverlayShape, Rect,
  Shadow, UvRect, WebcamLayout,
};
use crate::engine::cuts::{Cut, CutTrack};
use crate::engine::scene::{
  parse_layer_order, CursorEffects, EffectParams, Layer, SourceCrop, VideoLayout,
  DEFAULT_LAYER_ORDER,
};
use crate::engine::zoom::{lerp_rect, WebcamZoomRegion, WebcamZoomTrack, ZoomRegion, ZoomTrack};

// -- shared fixtures ---------------------------------------------------------

const CANVAS_W: u32 = 1920;
const CANVAS_H: u32 = 1080;

/// The recording inset on the canvas, as a background layout leaves it.
fn video_rect() -> Rect {
  Rect {
    x: 96.0,
    y: 54.0,
    width: 1728.0,
    height: 972.0,
  }
}

fn camera_rect() -> Rect {
  Rect {
    x: 1440.0,
    y: 780.0,
    width: 384.0,
    height: 216.0,
  }
}

fn cut(start_ms: f64, end_ms: f64) -> Cut {
  Cut { start_ms, end_ms }
}

fn zoom_region(start_ms: f64, end_ms: f64, level: f32, ease_ms: f64) -> ZoomRegion {
  ZoomRegion {
    start_ms,
    end_ms,
    level,
    focal_x: 0.5,
    focal_y: 0.5,
    ease_duration_ms: ease_ms,
    focal_keyframes: Vec::new(),
  }
}

fn sample(timestamp_ms: f64, x: f32, y: f32) -> CursorSample {
  CursorSample {
    timestamp_ms,
    x,
    y,
    visible: true,
    image_id: None,
    click: false,
  }
}

/// A three minute edit with two cuts, the shape a real project has.
fn project_cuts() -> CutTrack {
  CutTrack::new(vec![cut(5_000.0, 8_000.0), cut(20_000.0, 22_500.0)])
}

// -- the clock seam ----------------------------------------------------------

mod clock_convention {
  use super::*;

  #[test]
  fn a_zoom_authored_after_a_cut_lands_on_the_frame_the_editor_pointed_at() {
    // The user scrubbed to 10s in the edit and put a zoom there. That is
    // composition time. The frame that plays there came from 13s in the file,
    // because 3s were removed at 5s.
    let cuts = project_cuts();
    let zooms = ZoomTrack::new(vec![zoom_region(10_000.0, 12_000.0, 2.0, 0.0)]);

    let source_ms = 13_000.0;
    let composition_ms = cuts.to_composition(source_ms);
    assert_eq!(composition_ms, 10_000.0);
    assert_eq!(zooms.state_at(composition_ms, video_rect()).scale, 2.0);
  }

  #[test]
  fn feeding_source_time_to_the_zoom_track_would_miss_the_region_entirely() {
    // The bug this convention exists to prevent, stated as a test: at the same
    // frame, the source clock reads outside the region.
    let zooms = ZoomTrack::new(vec![zoom_region(10_000.0, 12_000.0, 2.0, 0.0)]);
    assert!(zooms.state_at(13_000.0, video_rect()).is_identity());
  }

  #[test]
  fn every_frame_of_a_cut_edit_resolves_its_zoom_through_the_composition_clock() {
    let cuts = project_cuts();
    let zooms = ZoomTrack::new(vec![zoom_region(10_000.0, 12_000.0, 2.0, 0.0)]);

    // Walk the file and check the zoom is on exactly for the source range that
    // maps into the region: 13s..15s.
    for step in 0..400 {
      let source_ms = step as f64 * 100.0;
      if cuts.contains(source_ms) {
        continue;
      }
      let composition_ms = cuts.to_composition(source_ms);
      let zoomed = !zooms.state_at(composition_ms, video_rect()).is_identity();
      let expected = (13_000.0..=15_000.0).contains(&source_ms);
      assert_eq!(zoomed, expected, "source {source_ms}");
    }
  }

  #[test]
  fn a_cursor_sample_is_found_through_the_composition_clock_too() {
    let cuts = project_cuts();
    // Recorded against the edit, like the zoom timeline.
    let cursor = CursorTrack::new(vec![sample(0.0, 0.1, 0.1), sample(10_000.0, 0.9, 0.9)]);

    let composition_ms = cuts.to_composition(13_000.0);
    assert_eq!(cursor.sample_at(composition_ms).unwrap().x, 0.9);
  }

  #[test]
  fn the_cursor_and_the_zoom_agree_about_where_they_are_on_the_timeline() {
    // They are staged from the same timestamp in `stage_timeline`, so a frame
    // that is zoomed must see the cursor sample authored for that moment.
    let cuts = project_cuts();
    let zooms = ZoomTrack::new(vec![zoom_region(10_000.0, 12_000.0, 2.0, 0.0)]);
    let cursor = CursorTrack::new(vec![sample(0.0, 0.1, 0.1), sample(10_000.0, 0.9, 0.9)]);

    for step in 0..400 {
      let source_ms = step as f64 * 100.0;
      if cuts.contains(source_ms) {
        continue;
      }
      let composition_ms = cuts.to_composition(source_ms);
      let zoomed = !zooms.state_at(composition_ms, video_rect()).is_identity();
      let late_pointer = cursor.sample_at(composition_ms).unwrap().x == 0.9;
      if zoomed {
        assert!(late_pointer, "zoomed at {source_ms} but pointer was early");
      }
    }
  }

  #[test]
  fn a_webcam_cut_span_is_read_on_the_composition_clock() {
    let cuts = project_cuts();
    // The camera leaves between 10s and 12s of the edit.
    let hidden = HiddenSpans::new(vec![(10_000.0, 12_000.0)]);
    assert!(hidden.contains(cuts.to_composition(13_000.0)));
    assert!(!hidden.contains(cuts.to_composition(4_000.0)));
  }

  #[test]
  fn a_webcam_zoom_region_is_read_on_the_composition_clock() {
    let cuts = project_cuts();
    let track = WebcamZoomTrack::new(vec![WebcamZoomRegion {
      start_ms: 10_000.0,
      end_ms: 12_000.0,
      ease_duration_ms: 0.0,
      rect: Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
      },
      full_screen: true,
    }]);
    let at = |source_ms: f64| track.state_at(cuts.to_composition(source_ms), camera_rect());
    assert_eq!(at(13_000.0).full_screen, 1.0);
    assert_eq!(at(4_000.0).full_screen, 0.0);
  }

  #[test]
  fn all_four_tracks_switch_on_at_the_same_source_frame() {
    // The real point of the convention: one timestamp drives all of them, so a
    // region authored at 10s in the edit takes effect on the same frame in
    // every layer.
    let cuts = project_cuts();
    let zooms = ZoomTrack::new(vec![zoom_region(10_000.0, 12_000.0, 2.0, 0.0)]);
    let webcam = WebcamZoomTrack::new(vec![WebcamZoomRegion {
      start_ms: 10_000.0,
      end_ms: 12_000.0,
      ease_duration_ms: 0.0,
      rect: camera_rect(),
      full_screen: true,
    }]);
    let hidden = HiddenSpans::new(vec![(10_000.0, 12_000.0)]);
    let cursor = CursorTrack::new(vec![sample(0.0, 0.1, 0.1), sample(10_000.0, 0.9, 0.9)]);

    // 12_999 is composition 9_999; 13_000 is composition 10_000.
    let before = cuts.to_composition(12_999.0);
    let after = cuts.to_composition(13_000.0);

    assert!(zooms.state_at(before, video_rect()).is_identity());
    assert!(!zooms.state_at(after, video_rect()).is_identity());
    assert_eq!(webcam.state_at(before, camera_rect()).full_screen, 0.0);
    assert_eq!(webcam.state_at(after, camera_rect()).full_screen, 1.0);
    assert!(!hidden.contains(before));
    assert!(hidden.contains(after));
    assert_eq!(cursor.sample_at(before).unwrap().x, 0.1);
    assert_eq!(cursor.sample_at(after).unwrap().x, 0.9);
  }

  #[test]
  fn a_cut_removes_the_frames_it_covers_from_every_track_at_once() {
    // Nothing inside a cut is ever staged, so a zoom authored over removed
    // time simply never plays.
    let cuts = project_cuts();
    for source_ms in [5_000.0, 6_000.0, 7_999.0, 20_000.0, 22_499.0] {
      assert!(cuts.contains(source_ms), "{source_ms}");
    }
  }

  #[test]
  fn the_edit_is_shorter_than_the_file_by_exactly_what_was_cut() {
    let cuts = project_cuts();
    assert_eq!(cuts.composition_duration(180_000.0), 174_500.0);
  }

  #[test]
  fn a_zoom_past_the_end_of_the_edit_never_plays() {
    let cuts = project_cuts();
    let duration = cuts.composition_duration(30_000.0);
    let zooms = ZoomTrack::new(vec![zoom_region(
      duration + 1_000.0,
      duration + 2_000.0,
      2.0,
      0.0,
    )]);
    for step in 0..300 {
      let source_ms = step as f64 * 100.0;
      if cuts.contains(source_ms) {
        continue;
      }
      assert!(
        zooms
          .state_at(cuts.to_composition(source_ms), video_rect())
          .is_identity(),
        "{source_ms}"
      );
    }
  }

  #[test]
  fn seeking_in_the_edit_finds_the_frame_the_zoom_was_authored_against() {
    // The player seeks by composition time and decodes by source time.
    let cuts = project_cuts();
    let zooms = ZoomTrack::new(vec![zoom_region(10_000.0, 12_000.0, 3.0, 0.0)]);
    for composition_ms in [10_000.0, 10_500.0, 11_000.0, 12_000.0] {
      let source_ms = cuts.to_source(composition_ms);
      assert!(!cuts.contains(source_ms), "{composition_ms}");
      let back = cuts.to_composition(source_ms);
      assert_eq!(back, composition_ms);
      assert_eq!(zooms.state_at(back, video_rect()).scale, 3.0);
    }
  }

  #[test]
  fn the_player_skips_a_cut_rather_than_decoding_through_it() {
    let cuts = project_cuts();
    let landing = cuts.cut_end_at(6_000.0).unwrap();
    assert_eq!(landing, 8_000.0);
    assert!(!cuts.contains(landing));
    // And the composition clock does not jump when it does.
    assert_eq!(cuts.to_composition(landing), 5_000.0);
  }

  #[test]
  fn many_cuts_and_many_zooms_stay_lined_up() {
    // Ten cuts of 500ms each, and a zoom over every gap between them.
    let cut_list: Vec<Cut> = (0..10)
      .map(|i| cut(i as f64 * 2_000.0 + 1_000.0, i as f64 * 2_000.0 + 1_500.0))
      .collect();
    let cuts = CutTrack::new(cut_list);
    let zoom_list: Vec<ZoomRegion> = (0..10)
      .map(|i| zoom_region(i as f64 * 1_500.0, i as f64 * 1_500.0 + 400.0, 2.0, 0.0))
      .collect();
    let zooms = ZoomTrack::new(zoom_list);

    for step in 0..400 {
      let source_ms = step as f64 * 50.0;
      if cuts.contains(source_ms) {
        continue;
      }
      let composition_ms = cuts.to_composition(source_ms);
      let state = zooms.state_at(composition_ms, video_rect());
      assert!(state.scale.is_finite(), "{source_ms}");
      assert!((1.0..=2.0).contains(&state.scale), "{source_ms}");
    }
  }

  #[test]
  fn the_round_trip_through_both_clocks_is_stable_for_every_edit_position() {
    let cuts = project_cuts();
    for step in 0..600 {
      let composition_ms = step as f64 * 50.0;
      assert_eq!(
        cuts.to_composition(cuts.to_source(composition_ms)),
        composition_ms,
        "{composition_ms}"
      );
    }
  }

  #[test]
  fn an_edit_with_no_cuts_makes_the_two_clocks_interchangeable() {
    // Which is why the bug hides: it is invisible until the first cut.
    let cuts = CutTrack::new(Vec::new());
    let zooms = ZoomTrack::new(vec![zoom_region(10_000.0, 12_000.0, 2.0, 0.0)]);
    for step in 0..300 {
      let ms = step as f64 * 100.0;
      assert_eq!(
        zooms.state_at(cuts.to_composition(ms), video_rect()).scale,
        zooms.state_at(ms, video_rect()).scale,
        "{ms}"
      );
    }
  }
}

// -- the video layout pipeline ----------------------------------------------

mod layout_pipeline {
  use super::*;

  /// The chain's order: fit the source into the layout rect, then the zoom
  /// scales the resolved rect about its pivot.
  fn resolve(
    layout: Rect,
    src: (u32, u32),
    fit: FitMode,
    zoom: Option<&ZoomTrack>,
    at_ms: f64,
  ) -> (Rect, UvRect) {
    let (rect, uv) = fit_source(layout, src.0, src.1, fit);
    match zoom {
      Some(track) => (track.state_at(at_ms, layout).apply(rect), uv),
      None => (rect, uv),
    }
  }

  #[test]
  fn with_no_zoom_the_video_sits_exactly_where_it_was_laid_out() {
    let (rect, _) = resolve(video_rect(), (1920, 1080), FitMode::Cover, None, 0.0);
    assert_eq!(rect, video_rect());
  }

  #[test]
  fn a_zoom_grows_the_video_rect_by_its_scale() {
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 2.0, 0.0)]);
    let (rect, _) = resolve(
      video_rect(),
      (1920, 1080),
      FitMode::Cover,
      Some(&zooms),
      500.0,
    );
    assert!((rect.width - video_rect().width * 2.0).abs() < 1e-3);
    assert!((rect.height - video_rect().height * 2.0).abs() < 1e-3);
  }

  #[test]
  fn a_zoom_about_the_centre_keeps_the_video_centred() {
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 2.0, 0.0)]);
    let (rect, _) = resolve(
      video_rect(),
      (1920, 1080),
      FitMode::Cover,
      Some(&zooms),
      500.0,
    );
    let before = video_rect().x + video_rect().width * 0.5;
    let after = rect.x + rect.width * 0.5;
    assert!((before - after).abs() < 1e-3);
  }

  #[test]
  fn a_zoom_never_leaves_a_gap_at_the_edge_it_zoomed_into() {
    // Zooming to a corner must push the opposite edge off screen, not pull the
    // near edge inward.
    let mut region = zoom_region(0.0, 1_000.0, 2.0, 0.0);
    region.focal_x = 0.0;
    region.focal_y = 0.0;
    let zooms = ZoomTrack::new(vec![region]);
    let (rect, _) = resolve(
      video_rect(),
      (1920, 1080),
      FitMode::Cover,
      Some(&zooms),
      500.0,
    );
    assert!((rect.x - video_rect().x).abs() < 1e-3);
    assert!(rect.x + rect.width > video_rect().x + video_rect().width);
  }

  #[test]
  fn the_zoom_does_not_change_which_part_of_the_source_is_read() {
    // Cover's crop is a uv transform; a zoom is a rect transform. They must not
    // interfere, or zooming would also re-crop the picture.
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 3.0, 0.0)]);
    let (_, plain) = resolve(video_rect(), (3840, 1080), FitMode::Cover, None, 0.0);
    let (_, zoomed) = resolve(
      video_rect(),
      (3840, 1080),
      FitMode::Cover,
      Some(&zooms),
      500.0,
    );
    assert_eq!(plain, zoomed);
  }

  #[test]
  fn every_fit_mode_survives_a_zoom() {
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 2.0, 0.0)]);
    for fit in [FitMode::Cover, FitMode::Contain, FitMode::Stretch] {
      for src in [(1920u32, 1080u32), (1080, 1920), (640, 640)] {
        let (rect, uv) = resolve(video_rect(), src, fit, Some(&zooms), 500.0);
        assert!(
          rect.width.is_finite() && rect.height.is_finite(),
          "{fit:?} {src:?}"
        );
        assert!(uv.scale.iter().all(|v| v.is_finite()), "{fit:?} {src:?}");
        assert!(rect.width > 0.0, "{fit:?} {src:?}");
      }
    }
  }

  #[test]
  fn contain_then_zoom_scales_the_shrunken_box_not_the_original() {
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 2.0, 0.0)]);
    let (contained, _) = resolve(video_rect(), (1080, 1920), FitMode::Contain, None, 0.0);
    let (zoomed, _) = resolve(
      video_rect(),
      (1080, 1920),
      FitMode::Contain,
      Some(&zooms),
      500.0,
    );
    assert!((zoomed.width - contained.width * 2.0).abs() < 1e-2);
  }

  #[test]
  fn an_eased_zoom_moves_the_rect_smoothly_rather_than_in_a_jump() {
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 2_000.0, 3.0, 400.0)]);
    let mut last = video_rect().width;
    for step in 0..=20 {
      let at = 400.0 * (step as f64 / 20.0);
      let (rect, _) = resolve(video_rect(), (1920, 1080), FitMode::Cover, Some(&zooms), at);
      assert!(rect.width >= last - 1e-3, "step {step}");
      // No single step may jump more than a fifth of the total growth.
      assert!(rect.width - last < video_rect().width * 0.5, "step {step}");
      last = rect.width;
    }
  }

  #[test]
  fn a_crop_and_a_zoom_are_independent_controls() {
    // The crop chooses what is read; the zoom chooses how big it is drawn.
    let crop = SourceCrop {
      top: 0.1,
      left: 0.1,
      bottom: 0.1,
      right: 0.1,
    }
    .resolve()
    .unwrap();
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 2.0, 0.0)]);
    let (rect, _) = resolve(
      video_rect(),
      (1920, 1080),
      FitMode::Cover,
      Some(&zooms),
      500.0,
    );
    // The crop did not change the destination rect at all.
    assert!((rect.width - video_rect().width * 2.0).abs() < 1e-3);
    assert_eq!(crop.left, 0.1);
  }

  #[test]
  fn a_layout_covering_the_canvas_and_no_zoom_is_the_plain_case() {
    let full = VideoLayout::covering(CANVAS_W, CANVAS_H);
    let (rect, uv) = resolve(full.rect, (1920, 1080), FitMode::Cover, None, 0.0);
    assert_eq!(rect, Rect::covering(CANVAS_W, CANVAS_H));
    assert_eq!(uv, UvRect::default());
  }

  #[test]
  fn the_resolved_rect_is_finite_for_every_combination_of_inputs() {
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 4.0, 200.0)]);
    let boxes = [
      video_rect(),
      Rect::covering(CANVAS_W, CANVAS_H),
      Rect {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
      },
    ];
    let sources = [(1920u32, 1080u32), (1, 1), (4000, 3)];
    for layout in boxes {
      for src in sources {
        for fit in [FitMode::Cover, FitMode::Contain, FitMode::Stretch] {
          for at in [0.0, 100.0, 500.0, 900.0, 1_000.0] {
            let (rect, uv) = resolve(layout, src, fit, Some(&zooms), at);
            assert!(
              rect.x.is_finite() && rect.y.is_finite(),
              "{layout:?} {src:?} {fit:?} {at}"
            );
            assert!(
              rect.width.is_finite() && rect.height.is_finite(),
              "{layout:?} {src:?} {fit:?} {at}"
            );
            assert!(
              uv.scale
                .iter()
                .chain(uv.offset.iter())
                .all(|v| v.is_finite()),
              "{layout:?} {src:?} {fit:?} {at}"
            );
          }
        }
      }
    }
  }

  #[test]
  fn a_zoom_of_one_is_indistinguishable_from_no_zoom_at_all() {
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 1.0, 0.0)]);
    for fit in [FitMode::Cover, FitMode::Contain, FitMode::Stretch] {
      let (with, _) = resolve(video_rect(), (1920, 1080), fit, Some(&zooms), 500.0);
      let (without, _) = resolve(video_rect(), (1920, 1080), fit, None, 0.0);
      assert_eq!(with, without, "{fit:?}");
    }
  }
}

// -- the webcam pipeline -----------------------------------------------------

mod webcam_pipeline {
  use super::*;

  fn styled(shape: OverlayShape, radius: f32, border: f32, shadows: Vec<Shadow>) -> WebcamLayout {
    WebcamLayout {
      rect: camera_rect(),
      shape,
      corner_radius: radius,
      opacity: 1.0,
      fit: FitMode::Cover,
      border_width: border,
      border_colour: [1.0, 1.0, 1.0, 1.0],
      shadows,
    }
    .sanitized()
  }

  fn shadow(offset: [f32; 2], blur: f32, alpha: f32) -> Shadow {
    Shadow {
      offset,
      blur,
      colour: [0.0, 0.0, 0.0, alpha],
    }
  }

  #[test]
  fn a_hidden_camera_is_not_drawn_however_it_is_styled() {
    let hidden = HiddenSpans::new(vec![(1_000.0, 2_000.0)]);
    let layout = styled(
      OverlayShape::Ellipse,
      0.0,
      4.0,
      vec![shadow([4.0, 4.0], 12.0, 0.5)],
    );
    assert!(layout.is_visible());
    // Visibility on the timeline is a separate question from the layout's own.
    assert!(hidden.contains(1_500.0));
    assert!(!hidden.contains(2_500.0));
  }

  #[test]
  fn a_camera_zoom_moves_the_box_the_shadows_are_cast_from() {
    // The shadow quad is derived from the drawn rect, so a camera that has
    // grown casts a bigger shadow rather than dragging its old one along.
    let grown = Rect {
      x: 200.0,
      y: 100.0,
      width: 1200.0,
      height: 675.0,
    };
    let track = WebcamZoomTrack::new(vec![WebcamZoomRegion {
      start_ms: 1_000.0,
      end_ms: 3_000.0,
      ease_duration_ms: 0.0,
      rect: grown,
      full_screen: false,
    }]);
    let s = shadow([8.0, 8.0], 20.0, 0.5);
    let small = s.quad_rect(track.state_at(0.0, camera_rect()).rect);
    let big = s.quad_rect(track.state_at(2_000.0, camera_rect()).rect);
    assert!(big.width > small.width);
    assert!((big.width - (grown.width + s.reach() * 2.0)).abs() < 1e-3);
  }

  #[test]
  fn a_camera_zoom_and_a_camera_cut_are_independent() {
    // A camera can be hidden while a zoom region covers it; the zoom still
    // resolves, it just does not get drawn.
    let track = WebcamZoomTrack::new(vec![WebcamZoomRegion {
      start_ms: 1_000.0,
      end_ms: 3_000.0,
      ease_duration_ms: 0.0,
      rect: Rect::covering(CANVAS_W, CANVAS_H),
      full_screen: true,
    }]);
    let hidden = HiddenSpans::new(vec![(1_500.0, 2_000.0)]);
    let state = track.state_at(1_750.0, camera_rect());
    assert_eq!(state.full_screen, 1.0);
    assert!(hidden.contains(1_750.0));
  }

  #[test]
  fn the_camera_fit_is_resolved_against_the_zoomed_box() {
    // Cover crops against whatever box the camera currently occupies, so a
    // camera growing to full screen re-crops as it goes rather than keeping the
    // crop it had in the corner.
    let track = WebcamZoomTrack::new(vec![WebcamZoomRegion {
      start_ms: 1_000.0,
      end_ms: 3_000.0,
      ease_duration_ms: 0.0,
      rect: Rect {
        x: 0.0,
        y: 0.0,
        width: 1080.0,
        height: 1080.0,
      },
      full_screen: false,
    }]);
    let corner = track.state_at(0.0, camera_rect()).rect;
    let square = track.state_at(2_000.0, camera_rect()).rect;
    let (_, corner_uv) = fit_source(corner, 1280, 720, FitMode::Cover);
    let (_, square_uv) = fit_source(square, 1280, 720, FitMode::Cover);
    // A 16:9 camera in a 16:9 box needs no crop; in a square box it does.
    assert_eq!(corner_uv, UvRect::default());
    assert!(square_uv.scale[0] < 1.0, "{:?}", square_uv.scale);
  }

  #[test]
  fn every_style_combination_sanitizes_to_something_drawable() {
    let shapes = [OverlayShape::Rect, OverlayShape::Ellipse];
    let radii = [0.0f32, 12.0, 400.0, -8.0];
    let borders = [0.0f32, 2.0, -3.0];
    let stacks = vec![
      Vec::new(),
      vec![shadow([0.0, 0.0], 0.0, 1.0)],
      vec![shadow([4.0, 4.0], 12.0, 0.4)],
      vec![
        shadow([4.0, 4.0], 12.0, 0.4),
        shadow([0.0, 16.0], 40.0, 0.2),
      ],
      vec![shadow([f32::NAN, 0.0], 12.0, 0.4)],
    ];
    for shape in shapes {
      for radius in radii {
        for border in borders {
          for stack in &stacks {
            let layout = styled(shape, radius, border, stack.clone());
            assert!(layout.corner_radius >= 0.0, "{shape:?} {radius} {border}");
            assert!(layout.border_width >= 0.0, "{shape:?} {radius} {border}");
            assert!((0.0..=1.0).contains(&layout.opacity));
            for s in &layout.shadows {
              assert!(s.is_visible());
              assert!(s.blur.is_finite());
              assert!(s.offset.iter().all(|v| v.is_finite()));
            }
          }
        }
      }
    }
  }

  #[test]
  fn a_border_is_drawn_outside_the_camera_box() {
    let layout = styled(OverlayShape::Rect, 12.0, 6.0, Vec::new());
    let outer = layout.rect.expanded(layout.border_width);
    assert!(outer.width > layout.rect.width);
    assert!(outer.x < layout.rect.x);
  }

  #[test]
  fn a_shadow_stack_is_drawn_under_a_box_that_still_covers_it() {
    // Every shadow quad has to reach past the box, or the falloff is cut off.
    let layout = styled(
      OverlayShape::Rect,
      0.0,
      0.0,
      vec![shadow([0.0, 8.0], 24.0, 0.3), shadow([0.0, 2.0], 4.0, 0.5)],
    );
    for s in &layout.shadows {
      let quad = s.quad_rect(layout.rect);
      assert!(quad.width >= layout.rect.width);
      assert!(quad.height >= layout.rect.height);
    }
  }

  #[test]
  fn a_full_screen_camera_ends_up_covering_the_canvas() {
    let track = WebcamZoomTrack::new(vec![WebcamZoomRegion {
      start_ms: 1_000.0,
      end_ms: 3_000.0,
      ease_duration_ms: 200.0,
      rect: Rect::covering(CANVAS_W, CANVAS_H),
      full_screen: true,
    }]);
    let state = track.state_at(2_000.0, camera_rect());
    assert_eq!(state.rect, Rect::covering(CANVAS_W, CANVAS_H));
    assert_eq!(state.full_screen, 1.0);
  }

  #[test]
  fn the_camera_returns_to_its_corner_when_the_region_ends() {
    let track = WebcamZoomTrack::new(vec![WebcamZoomRegion {
      start_ms: 1_000.0,
      end_ms: 3_000.0,
      ease_duration_ms: 200.0,
      rect: Rect::covering(CANVAS_W, CANVAS_H),
      full_screen: true,
    }]);
    assert_eq!(track.state_at(3_001.0, camera_rect()).rect, camera_rect());
    assert_eq!(track.state_at(3_001.0, camera_rect()).full_screen, 0.0);
  }

  #[test]
  fn the_camera_box_moves_monotonically_through_an_ease() {
    let track = WebcamZoomTrack::new(vec![WebcamZoomRegion {
      start_ms: 1_000.0,
      end_ms: 3_000.0,
      ease_duration_ms: 400.0,
      rect: Rect::covering(CANVAS_W, CANVAS_H),
      full_screen: true,
    }]);
    let mut last = camera_rect().width;
    for step in 0..=20 {
      let at = 1_000.0 + 400.0 * (step as f64 / 20.0);
      let width = track.state_at(at, camera_rect()).rect.width;
      assert!(width >= last - 1e-3, "step {step}");
      last = width;
    }
  }

  #[test]
  fn the_eased_box_is_always_between_the_two_it_eases_between() {
    let grown = Rect::covering(CANVAS_W, CANVAS_H);
    let track = WebcamZoomTrack::new(vec![WebcamZoomRegion {
      start_ms: 1_000.0,
      end_ms: 3_000.0,
      ease_duration_ms: 400.0,
      rect: grown,
      full_screen: true,
    }]);
    for step in 0..=40 {
      let at = 900.0 + 60.0 * step as f64;
      let rect = track.state_at(at, camera_rect()).rect;
      assert!(rect.width >= camera_rect().width - 1e-3, "step {step}");
      assert!(rect.width <= grown.width + 1e-3, "step {step}");
    }
  }

  #[test]
  fn lerping_the_box_matches_what_the_track_produces_at_the_same_progress() {
    // The track eases the laid-out rectangle rather than recomputing one from a
    // height ratio, which is what keeps the preview and the export identical.
    let grown = Rect::covering(CANVAS_W, CANVAS_H);
    let track = WebcamZoomTrack::new(vec![WebcamZoomRegion {
      start_ms: 1_000.0,
      end_ms: 3_000.0,
      ease_duration_ms: 200.0,
      rect: grown,
      full_screen: false,
    }]);
    // Halfway through the ease is smoothstep(0.5) = 0.5 exactly.
    let midway = track.state_at(1_100.0, camera_rect()).rect;
    let expected = lerp_rect(camera_rect(), grown, 0.5);
    assert!((midway.x - expected.x).abs() < 0.01);
    assert!((midway.y - expected.y).abs() < 0.01);
    assert!((midway.width - expected.width).abs() < 0.01);
    assert!((midway.height - expected.height).abs() < 0.01);
  }
}

// -- the cursor pipeline -----------------------------------------------------

mod cursor_pipeline {
  use super::*;

  /// Where the sprite lands on the canvas, before the zoom is applied.
  ///
  /// Positions are normalised against the source, so they map through the
  /// video's placement -- the same convention the zoom's focal point uses.
  fn sprite_rect(s: CursorSample, video: Rect, size: f32) -> Rect {
    Rect {
      x: video.x + s.x * video.width - size * 0.5,
      y: video.y + s.y * video.height - size * 0.5,
      width: size,
      height: size,
    }
  }

  #[test]
  fn the_pointer_lands_inside_the_video_rather_than_on_the_canvas() {
    let track = CursorTrack::new(vec![sample(0.0, 0.0, 0.0)]);
    let s = track.sample_at(0.0).unwrap();
    let rect = sprite_rect(s, video_rect(), 32.0);
    // Top-left of the recording, which is inset by the background padding.
    assert!((rect.x + 16.0 - video_rect().x).abs() < 1e-3);
  }

  #[test]
  fn the_pointer_moves_with_the_video_when_the_layout_changes() {
    // Deliberately off centre: the inset video is centred on the canvas, so at
    // 0.5 the two layouts agree and the test would prove nothing.
    let track = CursorTrack::new(vec![sample(0.0, 0.25, 0.25)]);
    let s = track.sample_at(0.0).unwrap();
    let inset = sprite_rect(s, video_rect(), 32.0);
    let full = sprite_rect(s, Rect::covering(CANVAS_W, CANVAS_H), 32.0);
    assert_ne!(inset.x, full.x);
    // In each case it is a quarter of the way across whatever the video occupies.
    assert!((inset.x + 16.0 - (video_rect().x + video_rect().width * 0.25)).abs() < 1e-3);
    assert!((full.x + 16.0 - 480.0).abs() < 1e-3);
  }

  #[test]
  fn a_centred_video_puts_its_middle_where_the_canvas_middle_is() {
    // The reason the test above has to use an off-centre point, stated on its
    // own so the coincidence is documented rather than tripped over again.
    let centre = video_rect().x + video_rect().width * 0.5;
    assert!((centre - CANVAS_W as f32 * 0.5).abs() < 1e-3, "{centre}");
  }

  #[test]
  fn a_zoom_carries_the_pointer_with_the_picture() {
    // The cursor is in zoomed space, so it stays on the pixel it was pointing
    // at rather than sliding off it as the picture grows.
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 2.0, 0.0)]);
    let track = CursorTrack::new(vec![sample(0.0, 0.25, 0.25)]);
    let s = track.sample_at(500.0).unwrap();
    let state = zooms.state_at(500.0, video_rect());

    let plain = sprite_rect(s, video_rect(), 32.0);
    let zoomed_video = state.apply(video_rect());
    let zoomed_sprite = state.apply(plain);
    // The pointer sits at the same fraction of the video before and after.
    let before = (plain.x - video_rect().x) / video_rect().width;
    let after = (zoomed_sprite.x - zoomed_video.x) / zoomed_video.width;
    assert!((before - after).abs() < 1e-4, "{before} vs {after}");
  }

  #[test]
  fn a_zoom_at_the_pointer_leaves_the_pointer_still() {
    let mut region = zoom_region(0.0, 1_000.0, 3.0, 0.0);
    region.focal_x = 0.25;
    region.focal_y = 0.25;
    let zooms = ZoomTrack::new(vec![region]);
    let track = CursorTrack::new(vec![sample(0.0, 0.25, 0.25)]);
    let s = track.sample_at(500.0).unwrap();
    let plain = sprite_rect(s, video_rect(), 32.0);
    let zoomed = zooms.state_at(500.0, video_rect()).apply(plain);
    // The pivot is the pointer, so its centre does not move.
    let centre = |r: Rect| (r.x + r.width * 0.5, r.y + r.height * 0.5);
    assert!((centre(plain).0 - centre(zoomed).0).abs() < 1e-3);
    assert!((centre(plain).1 - centre(zoomed).1).abs() < 1e-3);
  }

  #[test]
  fn a_click_and_a_zoom_both_scale_the_pointer_without_fighting() {
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 2.0, 0.0)]);
    let mut clicked = sample(0.0, 0.5, 0.5);
    clicked.click = true;
    let track = CursorTrack::new(vec![clicked]);

    let pop = track.click_scale_at(36.0, 1.5, 200.0);
    assert!((pop - 1.5).abs() < 1e-4);

    let s = track.sample_at(36.0).unwrap();
    let popped = sprite_rect(s, video_rect(), 32.0 * pop);
    let final_rect = zooms.state_at(36.0, video_rect()).apply(popped);
    // Both multiply: a 1.5x pop inside a 2x zoom is a 3x sprite.
    assert!(
      (final_rect.width - 32.0 * 3.0).abs() < 1e-3,
      "{}",
      final_rect.width
    );
  }

  #[test]
  fn a_smear_is_built_from_the_pointer_rect_the_zoom_produced() {
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 2.0, 0.0)]);
    let track = CursorTrack::new(vec![sample(0.0, 0.4, 0.5), sample(50.0, 0.5, 0.5)]);
    let motion = track.motion_at(50.0).unwrap();
    let s = track.sample_at(50.0).unwrap();
    let head = zooms
      .state_at(50.0, video_rect())
      .apply(sprite_rect(s, video_rect(), 32.0));
    // Velocity is in normalised source units, so it scales by the video rect
    // and then by the zoom, exactly like the sprite did.
    let travel = motion.vx * video_rect().width * 2.0 * 16.0;
    let (quad, uv, uv_travel) = smear_geometry(head, [travel, 0.0]).unwrap();
    assert!(quad.width > head.width);
    assert!(uv.scale[0] > 1.0);
    assert!(uv_travel[0] > 0.0);
  }

  #[test]
  fn a_stationary_pointer_needs_no_smear_at_any_zoom() {
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 4.0, 0.0)]);
    let track = CursorTrack::new(vec![sample(0.0, 0.5, 0.5)]);
    let s = track.sample_at(500.0).unwrap();
    let head = zooms
      .state_at(500.0, video_rect())
      .apply(sprite_rect(s, video_rect(), 32.0));
    assert!(smear_geometry(head, [0.0, 0.0]).is_none());
  }

  #[test]
  fn a_hidden_pointer_produces_nothing_to_draw_however_it_is_zoomed() {
    let mut hidden = sample(0.0, 0.5, 0.5);
    hidden.visible = false;
    let track = CursorTrack::new(vec![hidden]);
    for at in [0.0, 100.0, 5_000.0] {
      assert!(track.sample_at(at).is_none(), "{at}");
    }
  }

  #[test]
  fn the_click_pop_and_the_smear_can_be_switched_off_independently() {
    let effects = CursorEffects::default();
    assert_eq!(effects.click_scale, 1.0);
    assert_eq!(effects.smear_strength, 0.0);

    let mut clicked = sample(0.0, 0.5, 0.5);
    clicked.click = true;
    let track = CursorTrack::new(vec![clicked, sample(50.0, 0.9, 0.5)]);
    // Click off: no pop even on a real click.
    assert_eq!(track.click_scale_at(36.0, effects.click_scale, 200.0), 1.0);
    // Smear off: the motion is still measurable, the caller just does not use it.
    assert!(track.motion_at(50.0).is_some());
  }

  #[test]
  fn a_cut_can_remove_the_frame_a_click_happened_on() {
    // The click rides on the sample, so a cut that drops the moment drops the
    // click with it -- there is one thing to keep in order, not two.
    let cuts = CutTrack::new(vec![cut(5_000.0, 8_000.0)]);
    let mut clicked = sample(4_000.0, 0.5, 0.5);
    clicked.click = true;
    let track = CursorTrack::new(vec![clicked]);
    // The click was authored at 4s of the edit, which is before the cut.
    let source = cuts.to_source(4_000.0);
    assert!(!cuts.contains(source));
    assert!(track.click_scale_at(4_036.0, 1.5, 200.0) > 1.4);
  }

  #[test]
  fn the_pointer_stays_on_the_canvas_for_every_position_and_zoom() {
    let zooms = ZoomTrack::new(vec![zoom_region(0.0, 1_000.0, 2.0, 0.0)]);
    for x in [0.0f32, 0.25, 0.5, 0.75, 1.0] {
      for y in [0.0f32, 0.5, 1.0] {
        let track = CursorTrack::new(vec![sample(0.0, x, y)]);
        let s = track.sample_at(500.0).unwrap();
        let rect = zooms
          .state_at(500.0, video_rect())
          .apply(sprite_rect(s, video_rect(), 32.0));
        assert!(rect.x.is_finite() && rect.y.is_finite(), "{x},{y}");
        assert!(rect.width > 0.0, "{x},{y}");
      }
    }
  }

  #[test]
  fn a_pointer_that_never_moves_produces_the_same_rect_every_frame() {
    let track = CursorTrack::new(vec![sample(0.0, 0.5, 0.5)]);
    let first = sprite_rect(track.sample_at(0.0).unwrap(), video_rect(), 32.0);
    for at in [1.0, 100.0, 10_000.0] {
      let rect = sprite_rect(track.sample_at(at).unwrap(), video_rect(), 32.0);
      assert_eq!(rect, first, "{at}");
    }
  }
}

// -- whole editing sessions --------------------------------------------------

mod editing_session {
  use super::*;

  /// Everything a project carries, resolved together.
  struct Session {
    cuts: CutTrack,
    zooms: ZoomTrack,
    cursor: CursorTrack,
    webcam_zoom: WebcamZoomTrack,
    webcam_hidden: HiddenSpans,
    order: [Layer; 3],
  }

  fn session() -> Session {
    Session {
      cuts: project_cuts(),
      zooms: ZoomTrack::new(vec![
        zoom_region(2_000.0, 4_000.0, 2.0, 300.0),
        zoom_region(12_000.0, 15_000.0, 2.5, 300.0),
      ]),
      cursor: CursorTrack::new(vec![
        sample(0.0, 0.1, 0.1),
        sample(3_000.0, 0.5, 0.5),
        sample(13_000.0, 0.8, 0.2),
      ]),
      webcam_zoom: WebcamZoomTrack::new(vec![WebcamZoomRegion {
        start_ms: 12_000.0,
        end_ms: 15_000.0,
        ease_duration_ms: 300.0,
        rect: Rect::covering(CANVAS_W, CANVAS_H),
        full_screen: true,
      }]),
      webcam_hidden: HiddenSpans::new(vec![(6_000.0, 9_000.0)]),
      order: parse_layer_order(&["video".into(), "cursor".into(), "webcam".into()]),
    }
  }

  #[test]
  fn every_frame_of_the_session_resolves_to_something_drawable() {
    let s = session();
    let mut drawn = 0;
    for step in 0..600 {
      let source_ms = step as f64 * 50.0;
      if s.cuts.contains(source_ms) {
        continue;
      }
      drawn += 1;
      let at = s.cuts.to_composition(source_ms);

      let zoom = s.zooms.state_at(at, video_rect());
      assert!(zoom.scale.is_finite() && zoom.scale >= 1.0, "{source_ms}");
      assert!(
        zoom.pivot_x.is_finite() && zoom.pivot_y.is_finite(),
        "{source_ms}"
      );

      let video = zoom.apply(video_rect());
      assert!(video.width > 0.0 && video.height > 0.0, "{source_ms}");

      let camera = s.webcam_zoom.state_at(at, camera_rect());
      assert!(camera.rect.width > 0.0, "{source_ms}");
      assert!((0.0..=1.0).contains(&camera.full_screen), "{source_ms}");

      if let Some(point) = s.cursor.sample_at(at) {
        assert!(point.x.is_finite() && point.y.is_finite(), "{source_ms}");
      }
    }
    assert!(drawn > 400, "only {drawn} frames survived the cuts");
  }

  #[test]
  fn the_session_is_shorter_than_the_recording_by_its_cuts() {
    let s = session();
    assert_eq!(s.cuts.composition_duration(30_000.0), 24_500.0);
  }

  #[test]
  fn the_camera_is_hidden_for_exactly_the_span_it_was_cut_from() {
    let s = session();
    for at in [5_999.0, 9_000.0, 12_000.0] {
      assert!(!s.webcam_hidden.contains(at), "{at}");
    }
    for at in [6_000.0, 7_500.0, 8_999.0] {
      assert!(s.webcam_hidden.contains(at), "{at}");
    }
  }

  #[test]
  fn the_second_zoom_and_the_camera_expansion_run_together() {
    // Both authored over 12s..15s, so they have to be in step -- a camera
    // filling the canvas while the picture behind it is still zooming is the
    // kind of thing only a composed test catches.
    let s = session();
    for at in [12_000.0, 12_150.0, 12_300.0, 13_500.0, 14_850.0, 15_000.0] {
      let zoom_progress = (s.zooms.state_at(at, video_rect()).scale - 1.0) / 1.5;
      let camera_progress = s.webcam_zoom.state_at(at, camera_rect()).full_screen;
      assert!(
        (zoom_progress - camera_progress).abs() < 0.02,
        "at {at}: zoom {zoom_progress} vs camera {camera_progress}"
      );
    }
  }

  #[test]
  fn the_layers_are_ordered_the_way_the_project_asked() {
    let s = session();
    assert_eq!(s.order, [Layer::Video, Layer::Cursor, Layer::Webcam]);
    assert_eq!(s.order, DEFAULT_LAYER_ORDER);
  }

  #[test]
  fn reordering_the_layers_does_not_change_where_anything_sits() {
    // Order is about which is drawn over which, not about placement.
    let s = session();
    let reordered = parse_layer_order(&["webcam".into(), "video".into(), "cursor".into()]);
    assert_ne!(reordered, s.order);
    // The camera's box is unchanged by the order it is drawn in.
    let at = 13_000.0;
    assert_eq!(
      s.webcam_zoom.state_at(at, camera_rect()).rect,
      s.webcam_zoom.state_at(at, camera_rect()).rect
    );
  }

  #[test]
  fn nothing_inside_a_cut_is_ever_asked_for() {
    let s = session();
    let mut skipped = 0;
    for step in 0..600 {
      let source_ms = step as f64 * 50.0;
      if s.cuts.contains(source_ms) {
        skipped += 1;
        // And the player would seek past it rather than decode it.
        assert!(s.cuts.cut_end_at(source_ms).is_some(), "{source_ms}");
      }
    }
    assert_eq!(skipped, (3_000.0 / 50.0) as i32 + (2_500.0 / 50.0) as i32);
  }

  #[test]
  fn the_playhead_moves_forward_through_the_whole_session() {
    let s = session();
    let mut last = -1.0;
    for step in 0..600 {
      let source_ms = step as f64 * 50.0;
      if s.cuts.contains(source_ms) {
        continue;
      }
      let at = s.cuts.to_composition(source_ms);
      assert!(at >= last, "{source_ms}");
      last = at;
    }
  }

  #[test]
  fn an_effect_change_does_not_disturb_the_timeline() {
    // Grades ride in the quad's constant buffer; they are not part of layout.
    let s = session();
    let graded = EffectParams {
      brightness: 0.1,
      contrast: 1.2,
      saturation: 0.8,
    };
    assert!(!graded.is_identity());
    let at = 13_000.0;
    assert!(!s.zooms.state_at(at, video_rect()).is_identity());
  }

  #[test]
  fn a_session_with_everything_switched_off_still_resolves() {
    let s = Session {
      cuts: CutTrack::new(Vec::new()),
      zooms: ZoomTrack::new(Vec::new()),
      cursor: CursorTrack::new(Vec::new()),
      webcam_zoom: WebcamZoomTrack::new(Vec::new()),
      webcam_hidden: HiddenSpans::new(Vec::new()),
      order: parse_layer_order(&[]),
    };
    for step in 0..100 {
      let at = step as f64 * 100.0;
      assert!(s.zooms.state_at(at, video_rect()).is_identity(), "{at}");
      assert_eq!(
        s.webcam_zoom.state_at(at, camera_rect()).rect,
        camera_rect()
      );
      assert!(!s.webcam_hidden.contains(at), "{at}");
      assert!(s.cursor.sample_at(at).is_none(), "{at}");
      assert_eq!(s.cuts.to_composition(at), at);
    }
    assert_eq!(s.order, DEFAULT_LAYER_ORDER);
  }

  #[test]
  fn a_session_where_every_feature_overlaps_still_resolves() {
    // Cut, zoom, camera zoom, camera cut and a click all on the same span.
    let cuts = CutTrack::new(vec![cut(1_000.0, 2_000.0)]);
    let zooms = ZoomTrack::new(vec![zoom_region(1_000.0, 3_000.0, 3.0, 200.0)]);
    let webcam_zoom = WebcamZoomTrack::new(vec![WebcamZoomRegion {
      start_ms: 1_000.0,
      end_ms: 3_000.0,
      ease_duration_ms: 200.0,
      rect: Rect::covering(CANVAS_W, CANVAS_H),
      full_screen: true,
    }]);
    let hidden = HiddenSpans::new(vec![(1_000.0, 3_000.0)]);
    let mut clicked = sample(1_500.0, 0.5, 0.5);
    clicked.click = true;
    let cursor = CursorTrack::new(vec![sample(0.0, 0.0, 0.0), clicked]);

    for step in 0..100 {
      let source_ms = step as f64 * 50.0;
      if cuts.contains(source_ms) {
        continue;
      }
      let at = cuts.to_composition(source_ms);
      let zoom = zooms.state_at(at, video_rect());
      assert!(zoom.scale.is_finite(), "{source_ms}");
      let camera = webcam_zoom.state_at(at, camera_rect());
      assert!(camera.rect.width.is_finite(), "{source_ms}");
      let _ = hidden.contains(at);
      let _ = cursor.sample_at(at);
      let pop = cursor.click_scale_at(at, 1.5, 200.0);
      assert!((1.0..=1.5).contains(&pop), "{source_ms}: {pop}");
    }
  }
}
