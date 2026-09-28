//! What a composition is made of, independent of how it is drawn: the layer
//! order, per-layer effects, the source crop and where the video sits.
//!
//! No GPU types. Split out of `render` so the D3D11 renderer and the wgpu one
//! read the same description, and so all of it is tested on every platform.

use crate::engine::layout::{Grade, Rect, Shadow};

/// The layers that can be reordered, in the order they are drawn.
///
/// The background is not among them. It is the canvas the rest is drawn onto
/// rather than something stacked on it, and putting it above anything would
/// simply hide that thing -- so it stays the base and these three move.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layer {
  Video,
  Webcam,
  Cursor,
}

/// Bottom first, which is the order they are drawn in.
///
/// Deliberately webcam *below* cursor, matching the editor's own default. The
/// engine used to draw the pointer last unconditionally, so a cursor passing
/// over the camera box came out on top of it here and underneath it there --
/// a difference nobody would think to look for until they saw the export.
pub const DEFAULT_LAYER_ORDER: [Layer; 3] = [Layer::Video, Layer::Cursor, Layer::Webcam];

/// Read an order from the names the editor uses.
///
/// Anything missing keeps its default position and anything unknown is ignored,
/// because a layer list from a newer project should reorder what this build
/// understands rather than refusing to draw. `background` is accepted and
/// skipped: it is in the editor's list but it is the canvas, not a layer.
pub fn parse_layer_order(names: &[String]) -> [Layer; 3] {
  let mut order: Vec<Layer> = Vec::with_capacity(3);

  for name in names {
    let layer = match name.as_str() {
      "video" => Layer::Video,
      "webcam" => Layer::Webcam,
      "cursor" => Layer::Cursor,
      _ => continue,
    };
    if !order.contains(&layer) {
      order.push(layer);
    }
  }

  // Whatever was not named keeps its default position relative to the rest.
  for layer in DEFAULT_LAYER_ORDER {
    if !order.contains(&layer) {
      order.push(layer);
    }
  }

  [order[0], order[1], order[2]]
}

/// What a click does to the pointer, and how far it stretches when it moves.
///
/// Separate from `set_cursor_style` because size and opacity describe the
/// pointer and these describe its *motion*: they are resolved per frame against
/// the track rather than being fixed for the whole edit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CursorEffects {
  /// Peak scale of the click pop, taken about the hotspot so the tip stays on
  /// the pixel that was clicked. 1.0 disables it.
  pub click_scale: f32,
  pub click_duration_ms: f64,
  /// Multiplier on the length of the tail. 0 disables the smear.
  pub smear_strength: f32,
}

impl Default for CursorEffects {
  /// Both off. A caller that never asks for them gets the plain pointer, which
  /// is what every existing caller expects.
  fn default() -> Self {
    Self {
      click_scale: 1.0,
      click_duration_ms: 0.0,
      smear_strength: 0.0,
    }
  }
}

/// Parameters for the adjustable pass.
///
/// Identity values matter: when nothing is adjusted the chain skips a whole
/// pass and renders conversion straight into the destination.
#[derive(Clone, Copy, PartialEq)]
pub struct EffectParams {
  pub brightness: f32,
  pub contrast: f32,
  pub saturation: f32,
}

impl Default for EffectParams {
  fn default() -> Self {
    Self {
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
    }
  }
}

impl EffectParams {
  /// Whether this grade would change anything.
  ///
  /// No longer gates a render pass -- the grade rides in every quad's constant
  /// buffer now, so skipping it saves nothing -- but callers still want to ask.
  #[allow(dead_code)]
  pub fn is_identity(&self) -> bool {
    self.brightness == 0.0 && self.contrast == 1.0 && self.saturation == 1.0
  }
}

impl From<EffectParams> for Grade {
  fn from(params: EffectParams) -> Self {
    Grade {
      brightness: params.brightness,
      contrast: params.contrast,
      saturation: params.saturation,
    }
  }
}

/// Tightly packed RGBA8, before it is a texture.
pub struct RgbaImage {
  pub width: u32,
  pub height: u32,
  pub pixels: Vec<u8>,
}

/// A background as the caller describes it.
///
/// Separate from `Background` because this is the form that crosses a thread
/// boundary: the player's command channel carries one of these and the decode
/// thread turns it into a texture, the same way the cursor bitmap travels as
/// pixels rather than as an uploaded sprite.
pub struct BackgroundRequest {
  pub clear: [f32; 4],
  pub image: Option<RgbaImage>,
}

/// How much of each edge of the recording to throw away.
///
/// Fractions of the visible frame, not pixels, so a crop survives the recording
/// being scaled. Matches the editor's `SourceCropConfig`, including its refusal
/// to crop away more than 95% of either axis -- a crop that leaves nothing is
/// almost always a slider that got dragged too far, and honouring it means
/// sampling a sliver of texture across the whole video rect.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct SourceCrop {
  pub top: f32,
  pub left: f32,
  pub bottom: f32,
  pub right: f32,
}

/// The least of an axis a crop may leave, matching `MIN_VISIBLE_FRACTION`.
const MIN_VISIBLE_FRACTION: f32 = 0.05;

impl SourceCrop {
  /// `None` when the crop is absent, nonsense, or a no-op -- so the render path
  /// can skip it without re-deriving that.
  pub fn resolve(self) -> Option<Self> {
    let edge = |value: f32| {
      if value.is_finite() {
        value.clamp(0.0, 1.0 - MIN_VISIBLE_FRACTION)
      } else {
        0.0
      }
    };

    let crop = Self {
      top: edge(self.top),
      left: edge(self.left),
      bottom: edge(self.bottom),
      right: edge(self.right),
    };

    if crop.width() < MIN_VISIBLE_FRACTION || crop.height() < MIN_VISIBLE_FRACTION {
      return None;
    }
    if crop == Self::default() {
      return None;
    }

    Some(crop)
  }

  pub(crate) fn width(&self) -> f32 {
    1.0 - self.left - self.right
  }

  pub(crate) fn height(&self) -> f32 {
    1.0 - self.top - self.bottom
  }
}

/// Where the recording sits on the canvas, and what shape it is.
///
/// Pixel coordinates in the canvas, like `WebcamLayout` -- the padding
/// fraction, the scale and the centring are all resolved by the caller, so
/// there is one layout formula in the app rather than two that have to agree.
#[derive(Clone, Debug, PartialEq)]
pub struct VideoLayout {
  pub rect: Rect,
  pub corner_radius: f32,
  pub border_width: f32,
  pub border_colour: [f32; 4],
  /// Drop shadows under the recording, drawn in the order given.
  ///
  /// The same stack the camera takes, and for the same reason: lifting the
  /// recording off the background is a shadow, not a border, and a shadow is
  /// authored as layers -- one wide and faint for the ambient light, one tight
  /// and darker for the contact.
  pub shadows: Vec<Shadow>,
}

impl VideoLayout {
  /// The video filling the whole canvas, square corners, no border, no shadow.
  /// What the chain does before anyone sets a layout, and what a project with
  /// no background enabled wants -- there is no canvas left to cast onto.
  pub fn covering(width: u32, height: u32) -> Self {
    Self {
      rect: Rect::covering(width, height),
      corner_radius: 0.0,
      border_width: 0.0,
      border_colour: [0.0, 0.0, 0.0, 1.0],
      shadows: Vec::new(),
    }
  }

  pub(crate) fn sanitized(mut self) -> Self {
    self.corner_radius = self.corner_radius.max(0.0);
    self.border_width = self.border_width.max(0.0);
    // Same rule as the camera's: a shadow nobody can see still costs a quad the
    // size of the recording plus its blur, and two layers is the common case.
    self.shadows.retain(|shadow| {
      shadow.is_visible()
        && shadow.blur.is_finite()
        && shadow.offset[0].is_finite()
        && shadow.offset[1].is_finite()
    });
    if !self.rect.x.is_finite() || !self.rect.y.is_finite() {
      self.rect.x = 0.0;
      self.rect.y = 0.0;
    }
    if !self.rect.width.is_finite() || !self.rect.height.is_finite() {
      self.rect.width = 0.0;
      self.rect.height = 0.0;
    }
    self
  }
}

#[cfg(test)]
mod layer_order_tests {
  use super::*;

  fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn the_default_puts_the_camera_over_the_pointer() {
    // The editor's own default, and the thing the engine used to get wrong: it
    // drew the pointer last unconditionally, so a cursor crossing the camera
    // box came out on top here and underneath there.
    assert_eq!(
      DEFAULT_LAYER_ORDER,
      [Layer::Video, Layer::Cursor, Layer::Webcam]
    );
    assert_eq!(parse_layer_order(&names(&[])), DEFAULT_LAYER_ORDER);
  }

  #[test]
  fn a_named_order_is_followed() {
    assert_eq!(
      parse_layer_order(&names(&["webcam", "video", "cursor"])),
      [Layer::Webcam, Layer::Video, Layer::Cursor]
    );
  }

  #[test]
  fn the_background_is_accepted_and_skipped() {
    // It is in the editor's list but it is the canvas, not a layer.
    assert_eq!(
      parse_layer_order(&names(&["background", "video", "cursor", "webcam"])),
      [Layer::Video, Layer::Cursor, Layer::Webcam]
    );
  }

  #[test]
  fn a_partial_list_keeps_the_rest_where_they_were() {
    // Only the camera is named, so it goes to the bottom and the other two hold
    // their default order above it.
    assert_eq!(
      parse_layer_order(&names(&["webcam"])),
      [Layer::Webcam, Layer::Video, Layer::Cursor]
    );
  }

  #[test]
  fn an_unknown_layer_does_not_stop_the_rest_being_ordered() {
    // A project from a newer build naming a layer this one has never heard of
    // should still reorder what it does know.
    assert_eq!(
      parse_layer_order(&names(&["captions", "cursor", "video", "webcam"])),
      [Layer::Cursor, Layer::Video, Layer::Webcam]
    );
  }

  #[test]
  fn a_repeated_layer_counts_once() {
    assert_eq!(
      parse_layer_order(&names(&["cursor", "cursor", "webcam"])),
      [Layer::Cursor, Layer::Webcam, Layer::Video]
    );
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn crop(top: f32, left: f32, bottom: f32, right: f32) -> SourceCrop {
    SourceCrop {
      top,
      left,
      bottom,
      right,
    }
  }

  #[test]
  fn a_crop_of_nothing_is_no_crop() {
    assert!(SourceCrop::default().resolve().is_none());
  }

  #[test]
  fn a_real_crop_survives() {
    let resolved = crop(0.1, 0.2, 0.1, 0.2).resolve().unwrap();
    assert_eq!(resolved.width(), 0.6);
    assert!((resolved.height() - 0.8).abs() < 1e-6);
  }

  #[test]
  fn a_crop_that_leaves_nothing_is_refused() {
    // Almost certainly a slider dragged too far. Honouring it would stretch a
    // sliver of texture across the whole video rect.
    assert!(crop(0.0, 0.5, 0.0, 0.5).resolve().is_none());
    assert!(crop(0.99, 0.0, 0.99, 0.0).resolve().is_none());
  }

  #[test]
  fn each_edge_is_clamped_before_the_pair_is_judged() {
    // 2.0 on one edge alone would make the width negative, which reads as
    // "refuse" rather than "clamp" unless the edges are clamped first.
    let resolved = crop(0.0, 2.0, 0.0, 0.0).resolve().unwrap();
    assert_eq!(resolved.left, 1.0 - MIN_VISIBLE_FRACTION);
  }

  #[test]
  fn a_non_finite_edge_becomes_no_crop_on_that_edge() {
    let resolved = crop(f32::NAN, 0.25, 0.0, 0.0).resolve().unwrap();
    assert_eq!(resolved.top, 0.0);
    assert_eq!(resolved.left, 0.25);
  }

  #[test]
  fn a_negative_edge_clamps_to_zero() {
    let resolved = crop(-0.5, 0.25, 0.0, 0.0).resolve().unwrap();
    assert_eq!(resolved.top, 0.0);
  }
}

#[cfg(test)]
mod layer_order_scenarios {
  use super::*;

  fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn an_empty_list_gives_the_default_order() {
    assert_eq!(parse_layer_order(&[]), DEFAULT_LAYER_ORDER);
  }

  #[test]
  fn the_default_puts_the_camera_over_the_pointer() {
    // Matching the editor. The engine used to draw the pointer last no matter
    // what, so a cursor crossing the camera box came out on top here and
    // underneath there -- a difference nobody looks for until the export.
    assert_eq!(
      DEFAULT_LAYER_ORDER,
      [Layer::Video, Layer::Cursor, Layer::Webcam]
    );
  }

  #[test]
  fn a_full_named_order_is_followed_exactly() {
    assert_eq!(
      parse_layer_order(&names(&["webcam", "video", "cursor"])),
      [Layer::Webcam, Layer::Video, Layer::Cursor]
    );
  }

  #[test]
  fn every_permutation_of_the_three_names_round_trips() {
    let all = [
      ["video", "webcam", "cursor"],
      ["video", "cursor", "webcam"],
      ["webcam", "video", "cursor"],
      ["webcam", "cursor", "video"],
      ["cursor", "video", "webcam"],
      ["cursor", "webcam", "video"],
    ];
    for order in all {
      let parsed = parse_layer_order(&names(&order));
      let expected: Vec<Layer> = order
        .iter()
        .map(|name| match *name {
          "video" => Layer::Video,
          "webcam" => Layer::Webcam,
          _ => Layer::Cursor,
        })
        .collect();
      assert_eq!(parsed.to_vec(), expected, "{order:?}");
    }
  }

  #[test]
  fn the_background_is_accepted_and_skipped() {
    // It is in the editor's list but it is the canvas, not a layer -- putting
    // it above anything would simply hide that thing.
    assert_eq!(
      parse_layer_order(&names(&["background", "webcam", "video", "cursor"])),
      [Layer::Webcam, Layer::Video, Layer::Cursor]
    );
  }

  #[test]
  fn the_background_anywhere_in_the_list_is_skipped() {
    for position in 0..4 {
      let mut list = vec!["webcam", "video", "cursor"];
      list.insert(position, "background");
      assert_eq!(
        parse_layer_order(&names(&list)),
        [Layer::Webcam, Layer::Video, Layer::Cursor],
        "{position}"
      );
    }
  }

  #[test]
  fn an_unknown_name_does_not_stop_the_rest_being_ordered() {
    // A layer list from a newer project should reorder what this build
    // understands rather than refusing to draw.
    assert_eq!(
      parse_layer_order(&names(&["captions", "webcam", "sparkles", "video"])),
      [Layer::Webcam, Layer::Video, Layer::Cursor]
    );
  }

  #[test]
  fn a_list_of_nothing_but_unknown_names_gives_the_default() {
    assert_eq!(
      parse_layer_order(&names(&["captions", "sparkles", "background"])),
      DEFAULT_LAYER_ORDER
    );
  }

  #[test]
  fn a_partial_list_keeps_the_rest_where_they_were() {
    // Naming only the webcam moves it to the bottom; video and cursor keep
    // their relative order from the default.
    assert_eq!(
      parse_layer_order(&names(&["webcam"])),
      [Layer::Webcam, Layer::Video, Layer::Cursor]
    );
  }

  #[test]
  fn naming_only_the_cursor_lifts_it_to_the_bottom_of_the_stack() {
    assert_eq!(
      parse_layer_order(&names(&["cursor"])),
      [Layer::Cursor, Layer::Video, Layer::Webcam]
    );
  }

  #[test]
  fn naming_only_the_video_leaves_the_default_alone() {
    assert_eq!(parse_layer_order(&names(&["video"])), DEFAULT_LAYER_ORDER);
  }

  #[test]
  fn naming_two_layers_pins_them_and_appends_the_third() {
    assert_eq!(
      parse_layer_order(&names(&["cursor", "webcam"])),
      [Layer::Cursor, Layer::Webcam, Layer::Video]
    );
  }

  #[test]
  fn a_repeated_layer_counts_once() {
    assert_eq!(
      parse_layer_order(&names(&["webcam", "webcam", "video", "webcam"])),
      [Layer::Webcam, Layer::Video, Layer::Cursor]
    );
  }

  #[test]
  fn a_repeat_does_not_displace_a_later_first_mention() {
    assert_eq!(
      parse_layer_order(&names(&["cursor", "video", "cursor", "webcam"])),
      [Layer::Cursor, Layer::Video, Layer::Webcam]
    );
  }

  #[test]
  fn the_names_are_case_sensitive() {
    // The caller is a serialiser, so a capital is a bug on the sending side.
    assert_eq!(parse_layer_order(&names(&["Webcam"])), DEFAULT_LAYER_ORDER);
  }

  #[test]
  fn the_result_always_holds_each_layer_exactly_once() {
    let lists: [&[&str]; 6] = [
      &[],
      &["webcam"],
      &["webcam", "webcam", "webcam"],
      &["nonsense"],
      &["cursor", "background", "cursor"],
      &["video", "webcam", "cursor", "video"],
    ];
    for list in lists {
      let order = parse_layer_order(&names(list));
      for layer in [Layer::Video, Layer::Webcam, Layer::Cursor] {
        assert_eq!(
          order.iter().filter(|l| **l == layer).count(),
          1,
          "{list:?} missing or repeated {layer:?}"
        );
      }
    }
  }

  #[test]
  fn a_very_long_list_is_handled_without_overrunning_the_three_slots() {
    let long: Vec<String> = (0..500).map(|i| format!("layer{i}")).collect();
    assert_eq!(parse_layer_order(&long), DEFAULT_LAYER_ORDER);
  }
}

#[cfg(test)]
mod source_crop_scenarios {
  use super::*;

  fn crop(top: f32, left: f32, bottom: f32, right: f32) -> SourceCrop {
    SourceCrop {
      top,
      left,
      bottom,
      right,
    }
  }

  #[test]
  fn the_default_crop_is_no_crop() {
    assert_eq!(SourceCrop::default().resolve(), None);
  }

  #[test]
  fn a_crop_of_all_zeroes_is_no_crop() {
    assert_eq!(crop(0.0, 0.0, 0.0, 0.0).resolve(), None);
  }

  #[test]
  fn a_real_crop_survives() {
    assert_eq!(
      crop(0.1, 0.2, 0.1, 0.2).resolve(),
      Some(crop(0.1, 0.2, 0.1, 0.2))
    );
  }

  #[test]
  fn a_crop_on_one_edge_alone_survives() {
    for edge in 0..4 {
      let mut c = crop(0.0, 0.0, 0.0, 0.0);
      match edge {
        0 => c.top = 0.3,
        1 => c.left = 0.3,
        2 => c.bottom = 0.3,
        _ => c.right = 0.3,
      }
      assert!(c.resolve().is_some(), "edge {edge}");
    }
  }

  #[test]
  fn a_crop_that_would_leave_nothing_is_refused() {
    // Almost always a slider dragged too far, and honouring it means sampling
    // a sliver of texture stretched across the whole video rect.
    assert_eq!(crop(0.0, 0.6, 0.0, 0.6).resolve(), None);
    assert_eq!(crop(0.6, 0.0, 0.6, 0.0).resolve(), None);
  }

  #[test]
  fn the_threshold_is_bracketed_by_a_crop_either_side_of_it() {
    // Not tested exactly on the boundary: no pair of f32 edges leaves exactly
    // 0.05, so an "equal" case would really be testing which way the rounding
    // fell rather than the rule.
    let kept = crop(0.0, 0.46, 0.0, 0.46).resolve().unwrap();
    assert!(kept.width() > MIN_VISIBLE_FRACTION);
    assert_eq!(crop(0.0, 0.48, 0.0, 0.48).resolve(), None);
  }

  #[test]
  fn a_crop_leaving_a_hair_under_the_minimum_is_refused() {
    assert_eq!(crop(0.0, 0.48, 0.0, 0.48).resolve(), None);
  }

  #[test]
  fn each_edge_is_clamped_before_the_pair_is_judged() {
    // A single edge of 2.0 clamps to 0.95, which on its own still leaves 5%.
    let resolved = crop(0.0, 2.0, 0.0, 0.0).resolve().unwrap();
    assert!((resolved.left - 0.95).abs() < 1e-5, "{}", resolved.left);
    assert!(resolved.width() >= MIN_VISIBLE_FRACTION);
  }

  #[test]
  fn no_single_edge_may_take_more_than_ninety_five_percent() {
    for value in [0.96f32, 1.0, 5.0, 1e9] {
      let resolved = crop(value, 0.0, 0.0, 0.0).resolve().unwrap();
      assert!(resolved.top <= 1.0 - MIN_VISIBLE_FRACTION + 1e-6, "{value}");
    }
  }

  #[test]
  fn a_negative_edge_clamps_to_zero() {
    // A crop cannot grow the picture; a negative slider is a no-op edge.
    assert_eq!(crop(-1.0, 0.0, 0.0, 0.0).resolve(), None);
    let resolved = crop(-1.0, 0.2, 0.0, 0.0).resolve().unwrap();
    assert_eq!(resolved.top, 0.0);
  }

  #[test]
  fn a_non_finite_edge_becomes_no_crop_on_that_edge() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
      let resolved = crop(bad, 0.2, 0.0, 0.0).resolve().unwrap();
      assert_eq!(resolved.top, 0.0, "{bad}");
    }
  }

  #[test]
  fn a_crop_that_is_entirely_nonsense_resolves_to_nothing() {
    assert_eq!(crop(f32::NAN, f32::NAN, f32::NAN, f32::NAN).resolve(), None);
  }

  #[test]
  fn resolving_is_idempotent() {
    let once = crop(0.1, 0.2, 0.3, 0.05).resolve().unwrap();
    assert_eq!(once.resolve(), Some(once));
  }

  #[test]
  fn the_remaining_width_and_height_add_up() {
    let c = crop(0.1, 0.2, 0.3, 0.05);
    assert!((c.width() - 0.75).abs() < 1e-5, "{}", c.width());
    assert!((c.height() - 0.6).abs() < 1e-5, "{}", c.height());
  }

  #[test]
  fn an_uncropped_frame_is_the_whole_frame() {
    let c = SourceCrop::default();
    assert_eq!(c.width(), 1.0);
    assert_eq!(c.height(), 1.0);
  }

  #[test]
  fn a_resolved_crop_always_leaves_something_visible() {
    let cases = [
      (0.1f32, 0.1f32, 0.1f32, 0.1f32),
      (0.9, 0.0, 0.0, 0.0),
      (0.0, 0.9, 0.0, 0.0),
      (0.4, 0.4, 0.4, 0.4),
      (2.0, 0.0, 0.0, 0.0),
    ];
    for (t, l, b, r) in cases {
      if let Some(resolved) = crop(t, l, b, r).resolve() {
        assert!(
          resolved.width() >= MIN_VISIBLE_FRACTION - 1e-6,
          "{t} {l} {b} {r}"
        );
        assert!(
          resolved.height() >= MIN_VISIBLE_FRACTION - 1e-6,
          "{t} {l} {b} {r}"
        );
      }
    }
  }
}

#[cfg(test)]
mod effect_param_scenarios {
  use super::*;

  #[test]
  fn the_default_grade_changes_nothing() {
    assert!(EffectParams::default().is_identity());
  }

  #[test]
  fn the_identity_values_are_zero_brightness_and_unit_everything_else() {
    let d = EffectParams::default();
    assert_eq!(d.brightness, 0.0);
    assert_eq!(d.contrast, 1.0);
    assert_eq!(d.saturation, 1.0);
  }

  #[test]
  fn any_single_adjustment_breaks_the_identity() {
    let cases = [
      EffectParams {
        brightness: 0.1,
        ..Default::default()
      },
      EffectParams {
        contrast: 1.1,
        ..Default::default()
      },
      EffectParams {
        saturation: 0.0,
        ..Default::default()
      },
    ];
    for params in cases {
      assert!(!params.is_identity());
    }
  }

  #[test]
  fn a_tiny_adjustment_still_breaks_the_identity() {
    // Exact comparison, not a tolerance: the caller sets these from a slider
    // that snaps to the identity, so anything else is a deliberate value.
    let params = EffectParams {
      brightness: f32::MIN_POSITIVE,
      ..Default::default()
    };
    assert!(!params.is_identity());
  }

  #[test]
  fn the_grade_carries_the_three_numbers_across_unchanged() {
    let params = EffectParams {
      brightness: 0.2,
      contrast: 1.4,
      saturation: 0.6,
    };
    let grade: Grade = params.into();
    assert_eq!(grade.brightness, 0.2);
    assert_eq!(grade.contrast, 1.4);
    assert_eq!(grade.saturation, 0.6);
  }

  #[test]
  fn the_identity_params_convert_to_the_identity_grade() {
    // The two types hold the same three numbers and live in different layers;
    // if their identities ever drifted apart a "no effects" export would grade.
    let grade: Grade = EffectParams::default().into();
    assert_eq!(grade, Grade::default());
  }

  #[test]
  fn the_default_cursor_effects_are_both_off() {
    let d = CursorEffects::default();
    assert_eq!(d.click_scale, 1.0);
    assert_eq!(d.click_duration_ms, 0.0);
    assert_eq!(d.smear_strength, 0.0);
  }

  #[test]
  fn the_default_click_scale_is_the_value_that_disables_the_pop() {
    // Which is what `CursorTrack::click_scale_at` short-circuits on.
    assert_eq!(CursorEffects::default().click_scale, 1.0);
  }
}

#[cfg(test)]
mod video_layout_scenarios {
  use super::*;

  fn layout() -> VideoLayout {
    VideoLayout {
      rect: Rect {
        x: 40.0,
        y: 20.0,
        width: 1840.0,
        height: 1040.0,
      },
      corner_radius: 16.0,
      border_width: 2.0,
      border_colour: [1.0, 1.0, 1.0, 1.0],
      shadows: vec![Shadow {
        offset: [0.0, 18.0],
        blur: 45.0,
        colour: [0.0, 0.0, 0.0, 0.22],
      }],
    }
  }

  #[test]
  fn covering_fills_the_whole_canvas() {
    let l = VideoLayout::covering(1920, 1080);
    assert_eq!(l.rect, Rect::covering(1920, 1080));
  }

  #[test]
  fn covering_has_no_corners_and_no_border() {
    let l = VideoLayout::covering(1920, 1080);
    assert_eq!(l.corner_radius, 0.0);
    assert_eq!(l.border_width, 0.0);
  }

  #[test]
  fn covering_nothing_is_an_empty_rect() {
    assert!(VideoLayout::covering(0, 0).rect.is_empty());
  }

  #[test]
  fn sanitizing_refuses_a_negative_corner_radius() {
    let s = VideoLayout {
      corner_radius: -12.0,
      ..layout()
    }
    .sanitized();
    assert_eq!(s.corner_radius, 0.0);
  }

  #[test]
  fn sanitizing_refuses_a_negative_border() {
    let s = VideoLayout {
      border_width: -3.0,
      ..layout()
    }
    .sanitized();
    assert_eq!(s.border_width, 0.0);
  }

  #[test]
  fn sanitizing_flattens_a_non_finite_position() {
    for (x, y) in [(f32::NAN, 0.0), (0.0, f32::NAN), (f32::INFINITY, 0.0)] {
      let s = VideoLayout {
        rect: Rect {
          x,
          y,
          ..layout().rect
        },
        ..layout()
      }
      .sanitized();
      assert_eq!((s.rect.x, s.rect.y), (0.0, 0.0), "{x} {y}");
    }
  }

  #[test]
  fn sanitizing_flattens_a_non_finite_size() {
    for (w, h) in [(f32::NAN, 100.0), (100.0, f32::NAN), (f32::INFINITY, 1.0)] {
      let s = VideoLayout {
        rect: Rect {
          width: w,
          height: h,
          ..layout().rect
        },
        ..layout()
      }
      .sanitized();
      assert_eq!((s.rect.width, s.rect.height), (0.0, 0.0), "{w}x{h}");
    }
  }

  #[test]
  fn sanitizing_leaves_a_healthy_layout_alone() {
    assert_eq!(layout().sanitized(), layout());
  }

  #[test]
  fn sanitizing_drops_the_video_shadows_that_would_draw_nothing() {
    // Same rule the camera's layout follows. A shadow with no blur, no offset
    // and no alpha still costs a quad the size of the recording.
    let l = VideoLayout {
      shadows: vec![
        Shadow {
          offset: [0.0, 18.0],
          blur: 45.0,
          colour: [0.0, 0.0, 0.0, 0.22],
        },
        Shadow {
          offset: [0.0, 0.0],
          blur: 0.0,
          colour: [0.0, 0.0, 0.0, 0.5],
        },
        Shadow {
          offset: [0.0, 4.0],
          blur: 10.0,
          colour: [0.0, 0.0, 0.0, 0.0],
        },
        Shadow {
          offset: [0.0, 4.0],
          blur: f32::NAN,
          colour: [0.0, 0.0, 0.0, 0.16],
        },
        Shadow {
          offset: [f32::INFINITY, 4.0],
          blur: 10.0,
          colour: [0.0, 0.0, 0.0, 0.16],
        },
      ],
      ..layout()
    }
    .sanitized();

    assert_eq!(l.shadows.len(), 1);
    assert_eq!(l.shadows[0].blur, 45.0);
  }

  #[test]
  fn sanitizing_keeps_the_order_of_the_video_shadows_it_keeps() {
    // The stack is painted in order, so reordering it changes the picture.
    let l = VideoLayout {
      shadows: vec![
        Shadow {
          offset: [0.0, 18.0],
          blur: 45.0,
          colour: [0.0, 0.0, 0.0, 0.22],
        },
        Shadow {
          offset: [0.0, 0.0],
          blur: 0.0,
          colour: [0.0, 0.0, 0.0, 0.5],
        },
        Shadow {
          offset: [0.0, 4.0],
          blur: 10.0,
          colour: [0.0, 0.0, 0.0, 0.16],
        },
      ],
      ..layout()
    }
    .sanitized();

    assert_eq!(
      l.shadows.iter().map(|s| s.blur).collect::<Vec<_>>(),
      vec![45.0, 10.0]
    );
  }

  #[test]
  fn a_covering_layout_casts_no_shadow() {
    // Full-bleed: the recording is the canvas, so there is no background left
    // for a shadow to land on.
    assert!(VideoLayout::covering(1920, 1080).shadows.is_empty());
  }

  #[test]
  fn sanitizing_twice_is_the_same_as_once() {
    let messy = VideoLayout {
      corner_radius: -1.0,
      border_width: -1.0,
      rect: Rect {
        x: f32::NAN,
        ..layout().rect
      },
      ..layout()
    };
    let once = messy.sanitized();
    assert_eq!(once.clone().sanitized(), once);
  }

  #[test]
  fn sanitizing_does_not_touch_the_border_colour() {
    let s = VideoLayout {
      border_colour: [0.2, 0.4, 0.6, 0.8],
      ..layout()
    }
    .sanitized();
    assert_eq!(s.border_colour, [0.2, 0.4, 0.6, 0.8]);
  }

  #[test]
  fn a_bad_position_leaves_the_size_intact() {
    let s = VideoLayout {
      rect: Rect {
        x: f32::NAN,
        y: 5.0,
        width: 100.0,
        height: 50.0,
      },
      ..layout()
    }
    .sanitized();
    assert_eq!((s.rect.width, s.rect.height), (100.0, 50.0));
  }
}

#[cfg(test)]
mod layer_order_permutations {
  use super::*;

  const NAMES: [&str; 6] = ["video", "webcam", "cursor", "background", "captions", ""];

  fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn every_list_of_three_names_yields_each_layer_exactly_once() {
    for a in NAMES {
      for b in NAMES {
        for c in NAMES {
          let order = parse_layer_order(&names(&[a, b, c]));
          for layer in [Layer::Video, Layer::Webcam, Layer::Cursor] {
            assert_eq!(
              order.iter().filter(|l| **l == layer).count(),
              1,
              "[{a}, {b}, {c}] for {layer:?}"
            );
          }
        }
      }
    }
  }

  #[test]
  fn every_list_of_four_names_yields_each_layer_exactly_once() {
    for a in NAMES {
      for b in NAMES {
        for c in NAMES {
          for d in NAMES {
            let order = parse_layer_order(&names(&[a, b, c, d]));
            for layer in [Layer::Video, Layer::Webcam, Layer::Cursor] {
              assert_eq!(
                order.iter().filter(|l| **l == layer).count(),
                1,
                "[{a}, {b}, {c}, {d}] for {layer:?}"
              );
            }
          }
        }
      }
    }
  }

  #[test]
  fn every_permutation_of_the_three_real_names_is_followed_exactly() {
    let all = ["video", "webcam", "cursor"];
    for a in all {
      for b in all {
        for c in all {
          if a == b || b == c || a == c {
            continue;
          }
          let order = parse_layer_order(&names(&[a, b, c]));
          let expect = |name: &str| match name {
            "video" => Layer::Video,
            "webcam" => Layer::Webcam,
            _ => Layer::Cursor,
          };
          assert_eq!(order, [expect(a), expect(b), expect(c)], "[{a}, {b}, {c}]");
        }
      }
    }
  }

  #[test]
  fn a_name_that_is_not_a_layer_never_changes_the_result() {
    // Adding an unknown name anywhere leaves the order the real names produced.
    let filler = ["background", "captions", "", "sparkles"];
    for real in [
      vec!["webcam"],
      vec!["cursor", "video"],
      vec!["video", "webcam", "cursor"],
      vec![],
    ] {
      let base = parse_layer_order(&names(&real));
      for extra in filler {
        for position in 0..=real.len() {
          let mut list = real.clone();
          list.insert(position, extra);
          assert_eq!(
            parse_layer_order(&names(&list)),
            base,
            "{real:?} + {extra:?} at {position}"
          );
        }
      }
    }
  }

  #[test]
  fn repeating_a_name_never_changes_the_result() {
    for real in [
      vec!["webcam"],
      vec!["cursor", "video"],
      vec!["video", "webcam", "cursor"],
    ] {
      let base = parse_layer_order(&names(&real));
      let doubled: Vec<&str> = real.iter().flat_map(|n| [*n, *n]).collect();
      assert_eq!(parse_layer_order(&names(&doubled)), base, "{real:?}");
    }
  }

  #[test]
  fn a_named_layer_always_comes_before_every_unnamed_one() {
    for named in [
      vec!["video"],
      vec!["webcam"],
      vec!["cursor"],
      vec!["webcam", "cursor"],
      vec!["cursor", "video"],
    ] {
      let order = parse_layer_order(&names(&named));
      let as_layer = |n: &str| match n {
        "video" => Layer::Video,
        "webcam" => Layer::Webcam,
        _ => Layer::Cursor,
      };
      let named_layers: Vec<Layer> = named.iter().map(|n| as_layer(n)).collect();
      let mut seen_unnamed = false;
      for layer in order {
        if named_layers.contains(&layer) {
          assert!(
            !seen_unnamed,
            "{named:?}: {layer:?} came after an unnamed layer"
          );
        } else {
          seen_unnamed = true;
        }
      }
    }
  }

  #[test]
  fn the_unnamed_layers_keep_their_default_order_relative_to_each_other() {
    for named in [vec!["video"], vec!["webcam"], vec!["cursor"], vec![]] {
      let order = parse_layer_order(&names(&named));
      let as_layer = |n: &str| match n {
        "video" => Layer::Video,
        "webcam" => Layer::Webcam,
        _ => Layer::Cursor,
      };
      let named_layers: Vec<Layer> = named.iter().map(|n| as_layer(n)).collect();
      let leftover: Vec<Layer> = order
        .iter()
        .filter(|l| !named_layers.contains(l))
        .copied()
        .collect();
      let expected: Vec<Layer> = DEFAULT_LAYER_ORDER
        .iter()
        .filter(|l| !named_layers.contains(l))
        .copied()
        .collect();
      assert_eq!(leftover, expected, "{named:?}");
    }
  }

  #[test]
  fn an_empty_or_junk_only_list_always_gives_the_default() {
    let junk: [&[&str]; 5] = [
      &[],
      &[""],
      &["background"],
      &["captions", "sparkles"],
      &["background", "", "nonsense"],
    ];
    for list in junk {
      assert_eq!(
        parse_layer_order(&names(list)),
        DEFAULT_LAYER_ORDER,
        "{list:?}"
      );
    }
  }

  #[test]
  fn a_very_long_list_never_overruns_the_three_slots() {
    for count in [10usize, 100, 1_000] {
      let long: Vec<String> = (0..count).map(|i| format!("layer{i}")).collect();
      assert_eq!(parse_layer_order(&long), DEFAULT_LAYER_ORDER, "{count}");
    }
    let repeated: Vec<String> = (0..1_000).map(|_| "webcam".to_string()).collect();
    let order = parse_layer_order(&repeated);
    assert_eq!(order[0], Layer::Webcam);
  }
}

#[cfg(test)]
mod crop_matrix {
  use super::*;

  const EDGES: [f32; 12] = [
    -1e9, -1.0, -0.001, 0.0, 0.01, 0.05, 0.3, 0.5, 0.949, 0.95, 1.0, 1e9,
  ];

  fn crop(top: f32, left: f32, bottom: f32, right: f32) -> SourceCrop {
    SourceCrop {
      top,
      left,
      bottom,
      right,
    }
  }

  #[test]
  fn every_resolved_crop_leaves_at_least_the_minimum_visible() {
    for top in EDGES {
      for left in EDGES {
        for bottom in EDGES {
          if let Some(resolved) = crop(top, left, bottom, 0.0).resolve() {
            let label = format!("{top}/{left}/{bottom}");
            assert!(resolved.width() >= MIN_VISIBLE_FRACTION - 1e-4, "{label}");
            assert!(resolved.height() >= MIN_VISIBLE_FRACTION - 1e-4, "{label}");
          }
        }
      }
    }
  }

  #[test]
  fn every_resolved_edge_is_finite_and_in_range() {
    for top in EDGES {
      for left in EDGES {
        if let Some(r) = crop(top, left, 0.0, 0.0).resolve() {
          let label = format!("{top}/{left}");
          for edge in [r.top, r.left, r.bottom, r.right] {
            assert!(edge.is_finite(), "{label}");
            assert!(
              (0.0..=1.0 - MIN_VISIBLE_FRACTION).contains(&edge),
              "{label}: {edge}"
            );
          }
        }
      }
    }
  }

  #[test]
  fn a_non_finite_edge_always_becomes_no_crop_on_that_edge() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
      for other in [0.1f32, 0.3, 0.5] {
        let resolved = crop(bad, other, 0.0, 0.0).resolve();
        if let Some(r) = resolved {
          assert_eq!(r.top, 0.0, "{bad} with {other}");
        }
      }
    }
  }

  #[test]
  fn an_all_zero_crop_always_resolves_to_nothing() {
    assert_eq!(crop(0.0, 0.0, 0.0, 0.0).resolve(), None);
    assert_eq!(SourceCrop::default().resolve(), None);
    // And so does anything that clamps to all zeroes.
    for bad in [-1.0f32, -1e9, f32::NAN, f32::NEG_INFINITY] {
      assert_eq!(crop(bad, bad, bad, bad).resolve(), None, "{bad}");
    }
  }

  #[test]
  fn resolving_is_idempotent_for_every_crop_that_survives() {
    for top in EDGES {
      for left in EDGES {
        if let Some(once) = crop(top, left, 0.0, 0.0).resolve() {
          assert_eq!(once.resolve(), Some(once), "{top}/{left}");
        }
      }
    }
  }

  #[test]
  fn a_single_edge_crop_survives_for_every_reasonable_value() {
    for value in [0.01f32, 0.05, 0.3, 0.5, 0.9, 0.95, 2.0] {
      for edge in 0..4 {
        let c = match edge {
          0 => crop(value, 0.0, 0.0, 0.0),
          1 => crop(0.0, value, 0.0, 0.0),
          2 => crop(0.0, 0.0, value, 0.0),
          _ => crop(0.0, 0.0, 0.0, value),
        };
        assert!(c.resolve().is_some(), "edge {edge} at {value}");
      }
    }
  }

  #[test]
  fn opposite_edges_summing_past_the_limit_are_always_refused() {
    for pair in [(0.5f32, 0.5f32), (0.6, 0.4), (0.9, 0.9), (0.48, 0.48)] {
      assert_eq!(crop(0.0, pair.0, 0.0, pair.1).resolve(), None, "{pair:?} h");
      assert_eq!(crop(pair.0, 0.0, pair.1, 0.0).resolve(), None, "{pair:?} v");
    }
  }

  #[test]
  fn the_remaining_fractions_always_add_up() {
    for top in [0.0f32, 0.1, 0.3] {
      for bottom in [0.0f32, 0.1, 0.3] {
        for left in [0.0f32, 0.1, 0.3] {
          for right in [0.0f32, 0.1, 0.3] {
            let c = crop(top, left, bottom, right);
            assert!((c.width() - (1.0 - left - right)).abs() < 1e-6);
            assert!((c.height() - (1.0 - top - bottom)).abs() < 1e-6);
          }
        }
      }
    }
  }
}

#[cfg(test)]
mod grade_matrix {
  use super::*;

  const VALUES: [f32; 7] = [-2.0, -0.5, 0.0, 0.5, 1.0, 2.0, 100.0];

  #[test]
  fn the_identity_is_the_only_thing_that_reports_itself_as_one() {
    for brightness in VALUES {
      for contrast in VALUES {
        for saturation in VALUES {
          let params = EffectParams {
            brightness,
            contrast,
            saturation,
          };
          let expected = brightness == 0.0 && contrast == 1.0 && saturation == 1.0;
          assert_eq!(
            params.is_identity(),
            expected,
            "{brightness}/{contrast}/{saturation}"
          );
        }
      }
    }
  }

  #[test]
  fn every_parameter_set_converts_to_a_grade_field_for_field() {
    for brightness in VALUES {
      for contrast in VALUES {
        for saturation in VALUES {
          let params = EffectParams {
            brightness,
            contrast,
            saturation,
          };
          let grade: Grade = params.into();
          assert_eq!(grade.brightness, brightness);
          assert_eq!(grade.contrast, contrast);
          assert_eq!(grade.saturation, saturation);
        }
      }
    }
  }

  #[test]
  fn the_two_identities_always_agree() {
    // They are the same three numbers in two layers; if the identities ever
    // drifted apart a "no effects" export would grade.
    let grade: Grade = EffectParams::default().into();
    assert_eq!(grade, Grade::default());
    assert!(EffectParams::default().is_identity());
  }

  #[test]
  fn the_default_cursor_effects_disable_both_features() {
    let d = CursorEffects::default();
    assert_eq!(d.click_scale, 1.0);
    assert_eq!(d.click_duration_ms, 0.0);
    assert_eq!(d.smear_strength, 0.0);
  }
}

#[cfg(test)]
mod video_layout_matrix {
  use super::*;

  const BAD: [f32; 3] = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY];

  fn layout() -> VideoLayout {
    VideoLayout {
      rect: Rect {
        x: 10.0,
        y: 20.0,
        width: 300.0,
        height: 200.0,
      },
      corner_radius: 8.0,
      border_width: 2.0,
      border_colour: [1.0, 1.0, 1.0, 1.0],
      shadows: vec![Shadow {
        offset: [0.0, 18.0],
        blur: 45.0,
        colour: [0.0, 0.0, 0.0, 0.22],
      }],
    }
  }

  #[test]
  fn covering_any_canvas_gives_the_whole_canvas_with_no_decoration() {
    for (w, h) in [
      (1920u32, 1080u32),
      (1, 1),
      (0, 0),
      (3840, 2160),
      (100, 4000),
    ] {
      let l = VideoLayout::covering(w, h);
      assert_eq!(l.rect, Rect::covering(w, h), "{w}x{h}");
      assert_eq!(l.corner_radius, 0.0, "{w}x{h}");
      assert_eq!(l.border_width, 0.0, "{w}x{h}");
      assert_eq!(l.border_colour, [0.0, 0.0, 0.0, 1.0], "{w}x{h}");
    }
  }

  #[test]
  fn sanitising_always_leaves_a_finite_rect_for_any_bad_field() {
    for bad in BAD {
      for field in 0..4 {
        let mut rect = layout().rect;
        match field {
          0 => rect.x = bad,
          1 => rect.y = bad,
          2 => rect.width = bad,
          _ => rect.height = bad,
        }
        let s = VideoLayout { rect, ..layout() }.sanitized();
        let label = format!("{bad} field {field}");
        assert!(s.rect.x.is_finite(), "{label}");
        assert!(s.rect.y.is_finite(), "{label}");
        assert!(s.rect.width.is_finite(), "{label}");
        assert!(s.rect.height.is_finite(), "{label}");
      }
    }
  }

  #[test]
  fn sanitising_never_leaves_a_negative_radius_or_border() {
    for value in [-1e9f32, -100.0, -1.0, 0.0, 1.0, 1e9] {
      let s = VideoLayout {
        corner_radius: value,
        border_width: value,
        ..layout()
      }
      .sanitized();
      assert!(s.corner_radius >= 0.0, "{value}");
      assert!(s.border_width >= 0.0, "{value}");
    }
  }

  #[test]
  fn sanitising_is_idempotent_for_every_bad_field() {
    for bad in BAD {
      for field in 0..4 {
        let mut rect = layout().rect;
        match field {
          0 => rect.x = bad,
          1 => rect.y = bad,
          2 => rect.width = bad,
          _ => rect.height = bad,
        }
        let once = VideoLayout { rect, ..layout() }.sanitized();
        assert_eq!(once.clone().sanitized(), once, "{bad} field {field}");
      }
    }
  }

  #[test]
  fn sanitising_never_touches_a_healthy_layout() {
    for radius in [0.0f32, 8.0, 100.0] {
      for border in [0.0f32, 2.0, 50.0] {
        let l = VideoLayout {
          corner_radius: radius,
          border_width: border,
          ..layout()
        };
        assert_eq!(l.clone().sanitized(), l, "{radius}/{border}");
      }
    }
  }

  #[test]
  fn a_bad_position_never_wipes_out_a_good_size() {
    for bad in BAD {
      let s = VideoLayout {
        rect: Rect {
          x: bad,
          y: 5.0,
          width: 300.0,
          height: 200.0,
        },
        ..layout()
      }
      .sanitized();
      assert_eq!(s.rect.width, 300.0, "{bad}");
      assert_eq!(s.rect.height, 200.0, "{bad}");
    }
  }

  #[test]
  fn the_border_colour_always_survives_sanitising() {
    for colour in [
      [0.0f32, 0.0, 0.0, 1.0],
      [1.0, 1.0, 1.0, 1.0],
      [0.2, 0.4, 0.6, 0.8],
    ] {
      let s = VideoLayout {
        border_colour: colour,
        ..layout()
      }
      .sanitized();
      assert_eq!(s.border_colour, colour, "{colour:?}");
    }
  }
}

