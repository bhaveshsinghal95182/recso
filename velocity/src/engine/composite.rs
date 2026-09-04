//! Overlay drawing: the webcam box and the cursor sprite.
//!
//! Everything else in the render layer is a fullscreen pass writing an opaque
//! result. These two are not: they land in a rectangle of the destination and
//! blend with what is already there, which needs a quad, a blend state, and a
//! shape mask.
//!
//! Kept separate from `RenderChain` because the concerns barely overlap -- the
//! chain is about colour conversion and grading, this is about placement.
//! `RenderChain` owns one of these and calls it after the effect pass, so both
//! preview and export composite through the same code and cannot drift.

use windows::core::Result;
use windows::Win32::Graphics::Direct3D::D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;

use crate::engine::d3d::{gpu, Gpu};

/// A rectangle in destination pixels, origin top-left, y down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
  pub x: f32,
  pub y: f32,
  pub width: f32,
  pub height: f32,
}

impl Rect {
  pub fn is_empty(&self) -> bool {
    self.width <= 0.0 || self.height <= 0.0
  }

  /// Grow by `amount` on every side. Negative shrinks.
  ///
  /// This is how a border is drawn: the same rounded rect, expanded by the
  /// border width and filled, with the layer drawn over the top of it.
  pub fn expanded(self, amount: f32) -> Self {
    Self {
      x: self.x - amount,
      y: self.y - amount,
      width: self.width + amount * 2.0,
      height: self.height + amount * 2.0,
    }
  }

  /// The whole of a `width` x `height` surface.
  pub fn covering(width: u32, height: u32) -> Self {
    Self {
      x: 0.0,
      y: 0.0,
      width: width as f32,
      height: height as f32,
    }
  }

  /// To clip space. D3D's y runs up and the destination's runs down, so y flips.
  fn to_ndc(self, dst_width: u32, dst_height: u32) -> [f32; 4] {
    let w = dst_width.max(1) as f32;
    let h = dst_height.max(1) as f32;

    [
      (self.x / w) * 2.0 - 1.0,
      1.0 - (self.y / h) * 2.0,
      ((self.x + self.width) / w) * 2.0 - 1.0,
      1.0 - ((self.y + self.height) / h) * 2.0,
    ]
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlayShape {
  /// Square corners unless a radius is given.
  Rect,
  Ellipse,
}

/// How a source that does not match its box's aspect ratio is reconciled.
///
/// The engine owns this rather than the caller, because the engine is the only
/// side that knows the camera's real resolution -- the caller would have to
/// open the sidecar to find it out, which is exactly the demux the recorder
/// metadata work exists to avoid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FitMode {
  /// Fill the box exactly. Distorts when the aspect ratios differ; only right
  /// when the caller has already sized the box from the source.
  Stretch,
  /// Fill the box and crop the overflow. No distortion, no empty edges, some
  /// of the source is not shown. The only sane choice inside a circle.
  Cover,
  /// Fit the whole source inside the box and centre it. No distortion, nothing
  /// cropped; the box is drawn smaller than asked in one axis.
  Contain,
}

impl FitMode {
  /// `cover` | `contain` | `stretch` | `fill`, anything else falls back to the
  /// default.
  pub fn parse(name: &str) -> Self {
    match name {
      "stretch" | "fill" => Self::Stretch,
      "contain" => Self::Contain,
      _ => Self::Cover,
    }
  }
}

impl Default for FitMode {
  /// Cover, because it is the only mode that can never be visibly wrong: it
  /// distorts nothing and leaves no gap. Stretch is opt-in.
  fn default() -> Self {
    Self::Cover
  }
}

/// Where a quad reads its source from: `scale` of the texture, from `offset`.
///
/// Identity is scale (1, 1) at offset (0, 0). Cover shrinks the scale to crop;
/// contain leaves it at identity and shrinks the destination rect instead.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UvRect {
  pub scale: [f32; 2],
  pub offset: [f32; 2],
}

impl Default for UvRect {
  fn default() -> Self {
    Self {
      scale: [1.0, 1.0],
      offset: [0.0, 0.0],
    }
  }
}

/// Resolve a source of `src_width` x `src_height` into `rect` under `fit`.
///
/// Returns the rectangle to actually draw and the part of the source to read.
/// Cover crops the source and keeps the rect; contain keeps the source and
/// shrinks the rect. Doing cover through UVs rather than by growing the quad
/// matters because the shape mask is evaluated against the quad -- grow it and
/// a circular webcam would be clipped by the box instead of filling it.
pub fn fit_source(rect: Rect, src_width: u32, src_height: u32, fit: FitMode) -> (Rect, UvRect) {
  let src_w = src_width.max(1) as f32;
  let src_h = src_height.max(1) as f32;

  if fit == FitMode::Stretch || rect.is_empty() {
    return (rect, UvRect::default());
  }

  // How much wider the source is than the box. 1.0 means they already agree
  // and both modes collapse to a plain stretch.
  let ratio = (src_w / src_h) / (rect.width / rect.height);
  if !ratio.is_finite() || (ratio - 1.0).abs() < 1e-4 {
    return (rect, UvRect::default());
  }

  match fit {
    FitMode::Stretch => (rect, UvRect::default()),
    FitMode::Cover => {
      // Crop the long axis of the source down to the box's aspect ratio.
      let (sx, sy) = if ratio > 1.0 {
        (1.0 / ratio, 1.0)
      } else {
        (1.0, ratio)
      };
      (
        rect,
        UvRect {
          scale: [sx, sy],
          offset: [(1.0 - sx) * 0.5, (1.0 - sy) * 0.5],
        },
      )
    }
    FitMode::Contain => {
      // Shrink the box's short axis until the whole source fits, then recentre.
      let (w, h) = if ratio > 1.0 {
        (rect.width, rect.height / ratio)
      } else {
        (rect.width * ratio, rect.height)
      };
      (
        Rect {
          x: rect.x + (rect.width - w) * 0.5,
          y: rect.y + (rect.height - h) * 0.5,
          width: w,
          height: h,
        },
        UvRect::default(),
      )
    }
  }
}

/// Where the webcam goes and what shape it is.
///
/// Pixel coordinates in the destination, matching what the editor's compositor
/// computes -- the anchor grid and size ratios are resolved on the JS side and
/// arrive here already flattened, so there is exactly one placement formula in
/// the app rather than two that have to agree.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WebcamLayout {
  pub rect: Rect,
  pub shape: OverlayShape,
  pub corner_radius: f32,
  pub opacity: f32,
  pub fit: FitMode,
  /// Border thickness in canvas pixels, drawn outside the rect. Zero is none.
  pub border_width: f32,
  pub border_colour: [f32; 4],
}

impl Default for WebcamLayout {
  fn default() -> Self {
    Self {
      rect: Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
      },
      shape: OverlayShape::Rect,
      corner_radius: 0.0,
      opacity: 1.0,
      fit: FitMode::Cover,
      border_width: 0.0,
      border_colour: [0.0, 0.0, 0.0, 1.0],
    }
  }
}

impl WebcamLayout {
  pub fn is_visible(&self) -> bool {
    !self.rect.is_empty() && self.opacity > 0.0
  }

  /// Force the values into the ranges the shader assumes.
  ///
  /// Opacity above 1 does not brighten the overlay in any useful way -- it
  /// multiplies into the blend's source alpha and burns the feathered edge --
  /// and a negative radius makes the rounded-rect distance function fold
  /// inside out. Applied on the way in so no caller can produce either.
  pub fn sanitized(mut self) -> Self {
    self.opacity = self.opacity.clamp(0.0, 1.0);
    self.corner_radius = self.corner_radius.max(0.0);
    self.border_width = self.border_width.max(0.0);
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

/// The shaders, blend state and constant buffer the overlay passes need.
pub struct Overlays {
  vs: ID3D11VertexShader,
  ps_overlay: ID3D11PixelShader,
  ps_sprite: ID3D11PixelShader,
  ps_solid: ID3D11PixelShader,
  blend: ID3D11BlendState,
  constants: ID3D11Buffer,
}

/// One overlay draw, gathered up rather than passed as nine positional
/// arguments that are easy to transpose.
#[derive(Clone, Copy, Debug)]
pub struct Quad {
  /// Destination rectangle, in the render target's pixels.
  pub rect: Rect,
  pub shape: OverlayShape,
  pub corner_radius: f32,
  pub opacity: f32,
  /// Which part of the source to read. Default reads all of it.
  pub uv: UvRect,
  /// This quad's own colour adjustment. Identity leaves it alone.
  pub grade: Grade,
  /// Which shader draws it.
  pub fill: Fill,
}

/// A quad's colour adjustment, in the form the shader wants it.
///
/// Deliberately not `render::EffectParams`: that is the napi-facing type and
/// this module does not depend on the render layer. They hold the same three
/// numbers and `EffectParams` converts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grade {
  pub brightness: f32,
  pub contrast: f32,
  pub saturation: f32,
}

impl Default for Grade {
  fn default() -> Self {
    Self {
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
    }
  }
}

/// How a quad gets its colour.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Fill {
  /// Sample the texture, apply the grade, take the edge from the shape mask.
  /// The video and the webcam.
  Texture,
  /// Sample the texture and take alpha from the image itself. The cursor.
  Sprite,
  /// A flat colour, no texture. Borders.
  Solid([f32; 4]),
}

impl Overlays {
  pub fn new(
    gpu: &Gpu,
    vs: ID3D11VertexShader,
    ps_overlay: ID3D11PixelShader,
    ps_sprite: ID3D11PixelShader,
    ps_solid: ID3D11PixelShader,
  ) -> Result<Self> {
    // Straight alpha over the destination. The overlays are drawn after the
    // base is already opaque, so there is nothing to preserve in the
    // destination alpha and it just carries the source through.
    let mut target = D3D11_RENDER_TARGET_BLEND_DESC {
      BlendEnable: true.into(),
      SrcBlend: D3D11_BLEND_SRC_ALPHA,
      DestBlend: D3D11_BLEND_INV_SRC_ALPHA,
      BlendOp: D3D11_BLEND_OP_ADD,
      SrcBlendAlpha: D3D11_BLEND_ONE,
      DestBlendAlpha: D3D11_BLEND_INV_SRC_ALPHA,
      BlendOpAlpha: D3D11_BLEND_OP_ADD,
      RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
    };
    let mut desc = D3D11_BLEND_DESC::default();
    desc.RenderTarget[0] = std::mem::take(&mut target);

    let mut blend = None;
    unsafe { gpu.device.CreateBlendState(&desc, Some(&mut blend))? };

    // 20 floats: the rect, the mask, the grade, the uv sub-rect and the tint.
    let constants = super::render::create_constant_buffer(gpu, 20 * 4)?;

    Ok(Self {
      vs,
      ps_overlay,
      ps_sprite,
      ps_solid,
      blend: blend.unwrap(),
      constants,
    })
  }

  /// Draw one textured quad into `dst_rtv`.
  ///
  /// `quad.fill` picks the pixel shader: a sprite takes its alpha from the image
  /// (the cursor is a PNG with transparency), a texture is an opaque source that
  /// gets its edge from the shape mask, and a solid is a flat colour used for
  /// borders.
  ///
  /// Caller holds the render lock and owns viewport/topology restoration -- this
  /// sets what it needs and leaves nothing bound.
  pub fn draw(
    &self,
    ctx: &ID3D11DeviceContext,
    dst_rtv: &ID3D11RenderTargetView,
    source: &ID3D11ShaderResourceView,
    dst_width: u32,
    dst_height: u32,
    quad: Quad,
  ) -> Result<()> {
    if quad.rect.is_empty() || quad.opacity <= 0.0 {
      return Ok(());
    }

    let ndc = quad.rect.to_ndc(dst_width, dst_height);

    unsafe {
      self.upload(ctx, ndc, quad)?;

      ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
      ctx.IASetInputLayout(None);
      ctx.VSSetShader(&self.vs, None);
      // The rect lives in b1 and the VS reads it too, so it has to be bound on
      // both stages -- binding it only to the pixel shader draws a
      // zero-size quad and nothing appears.
      ctx.VSSetConstantBuffers(1, Some(&[Some(self.constants.clone())]));
      ctx.PSSetConstantBuffers(1, Some(&[Some(self.constants.clone())]));
      ctx.PSSetShader(
        match quad.fill {
          Fill::Texture => &self.ps_overlay,
          Fill::Sprite => &self.ps_sprite,
          Fill::Solid(_) => &self.ps_solid,
        },
        None,
      );
      // A solid quad still gets a bound source: leaving t0 pointing at whatever
      // the last draw used is how you get a device-removed on some drivers, and
      // the shader simply does not read it.
      ctx.PSSetShaderResources(0, Some(&[Some(source.clone())]));
      ctx.OMSetRenderTargets(Some(&[Some(dst_rtv.clone())]), None);
      ctx.OMSetBlendState(&self.blend, None, 0xffff_ffff);

      ctx.Draw(4, 0);

      // Back to opaque: the next frame's conversion pass writes a full frame
      // and must not blend with what is already in the slot.
      ctx.OMSetBlendState(None, None, 0xffff_ffff);
      ctx.PSSetShaderResources(0, Some(&[None]));
    }

    Ok(())
  }

  unsafe fn upload(&self, ctx: &ID3D11DeviceContext, ndc: [f32; 4], quad: Quad) -> Result<()> {
    let tint = match quad.fill {
      Fill::Solid(colour) => colour,
      _ => [0.0, 0.0, 0.0, 0.0],
    };

    let values = [
      ndc[0],
      ndc[1],
      ndc[2],
      ndc[3],
      quad.rect.width * 0.5,
      quad.rect.height * 0.5,
      quad.corner_radius,
      match quad.shape {
        OverlayShape::Rect => 0.0,
        OverlayShape::Ellipse => 1.0,
      },
      quad.opacity,
      quad.grade.brightness,
      quad.grade.contrast,
      quad.grade.saturation,
      quad.uv.scale[0],
      quad.uv.scale[1],
      quad.uv.offset[0],
      quad.uv.offset[1],
      tint[0],
      tint[1],
      tint[2],
      tint[3],
    ];

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe {
      ctx.Map(
        &self.constants,
        0,
        D3D11_MAP_WRITE_DISCARD,
        0,
        Some(&mut mapped),
      )?;
      std::ptr::copy_nonoverlapping(values.as_ptr(), mapped.pData as *mut f32, values.len());
      ctx.Unmap(&self.constants, 0);
    }

    Ok(())
  }
}

/// An RGBA image uploaded once and drawn many times.
///
/// The cursor bitmap changes rarely -- only when the user picks a different
/// cursor style or a region override kicks in -- so it is uploaded on change
/// rather than per frame.
pub struct SpriteTexture {
  #[allow(dead_code)]
  texture: ID3D11Texture2D,
  pub srv: ID3D11ShaderResourceView,
  pub width: u32,
  pub height: u32,
  /// Where the cursor's point actually is, in image pixels. Drawing at the
  /// image's top-left instead puts an arrow's tip a dozen pixels down-right of
  /// where the click landed.
  pub hotspot_x: f32,
  pub hotspot_y: f32,
}

impl SpriteTexture {
  /// `pixels` is tightly packed RGBA8, `width * height * 4` bytes.
  pub fn new(
    width: u32,
    height: u32,
    pixels: &[u8],
    hotspot_x: f32,
    hotspot_y: f32,
  ) -> Result<Self> {
    let gpu = gpu()?;

    let desc = D3D11_TEXTURE2D_DESC {
      Width: width,
      Height: height,
      MipLevels: 1,
      ArraySize: 1,
      // The shader reads .rgb and .a, and BGRA everywhere else in the chain
      // means the swizzle has to happen somewhere; doing it here keeps the
      // sprite shader identical to every other sampler in the file.
      Format: DXGI_FORMAT_R8G8B8A8_UNORM,
      SampleDesc: DXGI_SAMPLE_DESC {
        Count: 1,
        Quality: 0,
      },
      Usage: D3D11_USAGE_IMMUTABLE,
      BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
      ..Default::default()
    };

    let initial = D3D11_SUBRESOURCE_DATA {
      pSysMem: pixels.as_ptr() as *const _,
      SysMemPitch: width * 4,
      SysMemSlicePitch: 0,
    };

    let mut texture = None;
    unsafe {
      gpu
        .device
        .CreateTexture2D(&desc, Some(&initial), Some(&mut texture))?
    };
    let texture = texture.unwrap();

    let mut srv = None;
    unsafe {
      gpu
        .device
        .CreateShaderResourceView(&texture, None, Some(&mut srv))?
    };

    Ok(Self {
      texture,
      srv: srv.unwrap(),
      width,
      height,
      hotspot_x,
      hotspot_y,
    })
  }
}

/// The distinct pointer bitmaps a recording used, indexed by `CursorSample`.
///
/// Uploaded once when the table is set rather than per frame: the shapes are
/// fixed for the whole edit, and there are few enough of them that keeping
/// every one resident costs less than a megabyte.
#[derive(Default)]
pub struct CursorImages {
  images: Vec<SpriteTexture>,
}

impl CursorImages {
  pub fn new(images: Vec<SpriteTexture>) -> Self {
    Self { images }
  }

  /// The bitmap for an id, or `None` if the id is past the end.
  ///
  /// Out of range is not an error worth failing an export over: a track that
  /// references an image the caller did not send should draw the default
  /// pointer, not stop the render.
  pub fn get(&self, id: u32) -> Option<&SpriteTexture> {
    self.images.get(id as usize)
  }
}

/// One recorded cursor position.
///
/// Positions are normalised 0..1 against the *source* video, so they survive
/// the video being scaled into a different canvas. That is the same convention
/// the editor's compositor uses.
#[derive(Clone, Copy, Debug, Default)]
pub struct CursorSample {
  pub timestamp_ms: f64,
  pub x: f32,
  pub y: f32,
  pub visible: bool,
  /// Which bitmap the pointer was wearing, as an index into `CursorImages`.
  ///
  /// An index rather than the pixels because a recording contains thousands of
  /// samples and perhaps a dozen distinct shapes -- arrow, hand, I-beam, the
  /// resize variants. Carrying the image per sample would send the same few
  /// kilobytes across the boundary over and over.
  ///
  /// `None` falls back to the single default bitmap, which is what a caller
  /// that never sets a table gets for every sample.
  pub image_id: Option<u32>,
}

/// The recorded cursor path, searchable by playback position.
#[derive(Default)]
pub struct CursorTrack {
  samples: Vec<CursorSample>,
}

impl CursorTrack {
  /// Sorts on the way in so lookup can binary search. The recorder emits in
  /// order, but a track assembled from several sources might not be.
  pub fn new(mut samples: Vec<CursorSample>) -> Self {
    samples.sort_by(|a, b| a.timestamp_ms.total_cmp(&b.timestamp_ms));
    Self { samples }
  }

  pub fn len(&self) -> usize {
    self.samples.len()
  }

  /// The cursor position in effect at `timestamp_ms`.
  ///
  /// That is the last sample at or before the time, held until the next one --
  /// the pointer does not move between reports, and interpolating would invent
  /// motion that never happened. Returns `None` before the first sample, or
  /// when the sample in effect says the cursor was hidden.
  pub fn sample_at(&self, timestamp_ms: f64) -> Option<CursorSample> {
    if self.samples.is_empty() {
      return None;
    }

    // Index of the first sample strictly after the time; the one before it is
    // the one in effect.
    let upper = self
      .samples
      .partition_point(|s| s.timestamp_ms <= timestamp_ms);
    if upper == 0 {
      return None;
    }

    let sample = self.samples[upper - 1];
    if !sample.visible {
      return None;
    }

    Some(sample)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn sample(timestamp_ms: f64, x: f32) -> CursorSample {
    CursorSample {
      timestamp_ms,
      x,
      y: 0.5,
      visible: true,
      image_id: None,
    }
  }

  #[test]
  fn a_rect_maps_to_clip_space_with_y_flipped() {
    let rect = Rect {
      x: 0.0,
      y: 0.0,
      width: 960.0,
      height: 540.0,
    };
    let ndc = rect.to_ndc(1920, 1080);

    // Top-left of the destination is (-1, 1) in clip space.
    assert_eq!(ndc[0], -1.0);
    assert_eq!(ndc[1], 1.0);
    // Half way across and half way down is the centre.
    assert_eq!(ndc[2], 0.0);
    assert_eq!(ndc[3], 0.0);
  }

  #[test]
  fn a_full_frame_rect_covers_clip_space() {
    let rect = Rect {
      x: 0.0,
      y: 0.0,
      width: 1920.0,
      height: 1080.0,
    };
    assert_eq!(rect.to_ndc(1920, 1080), [-1.0, 1.0, 1.0, -1.0]);
  }

  #[test]
  fn an_empty_rect_is_not_drawn() {
    let layout = WebcamLayout::default();
    assert!(!layout.is_visible());
  }

  fn box_16_9() -> Rect {
    Rect {
      x: 100.0,
      y: 100.0,
      width: 320.0,
      height: 180.0,
    }
  }

  #[test]
  fn a_matching_aspect_ratio_needs_no_fitting() {
    // 640x360 is 16:9, same as the box, so every mode is a plain stretch.
    for fit in [FitMode::Stretch, FitMode::Cover, FitMode::Contain] {
      let (rect, uv) = fit_source(box_16_9(), 640, 360, fit);
      assert_eq!(rect, box_16_9());
      assert_eq!(uv, UvRect::default());
    }
  }

  #[test]
  fn stretch_leaves_the_source_alone_however_wrong_it_is() {
    // 4:3 into a 16:9 box. This is the distortion; stretch is opting into it.
    let (rect, uv) = fit_source(box_16_9(), 640, 480, FitMode::Stretch);
    assert_eq!(rect, box_16_9());
    assert_eq!(uv, UvRect::default());
  }

  #[test]
  fn cover_crops_a_wide_source_horizontally() {
    // 2:1 into 16:9. The source is wider, so the sides are cropped and the
    // rectangle is untouched.
    let (rect, uv) = fit_source(box_16_9(), 640, 320, FitMode::Cover);
    assert_eq!(rect, box_16_9());
    assert_eq!(uv.scale[1], 1.0, "the full height is still shown");
    assert!(uv.scale[0] < 1.0, "the width is cropped");
    // Centred: whatever is cropped is split evenly between the two sides.
    assert!((uv.offset[0] - (1.0 - uv.scale[0]) / 2.0).abs() < 1e-5);
    assert_eq!(uv.offset[1], 0.0);
  }

  #[test]
  fn cover_crops_a_tall_source_vertically() {
    // 4:3 into 16:9. The source is taller, so top and bottom go.
    let (rect, uv) = fit_source(box_16_9(), 640, 480, FitMode::Cover);
    assert_eq!(rect, box_16_9());
    assert_eq!(uv.scale[0], 1.0);
    assert!(uv.scale[1] < 1.0);
    // 4:3 in a 16:9 box keeps 3/4 of the height.
    assert!((uv.scale[1] - 0.75).abs() < 1e-5, "kept {}", uv.scale[1]);
  }

  #[test]
  fn contain_shrinks_the_box_instead_of_the_source() {
    // 4:3 into 16:9: the whole camera is shown, so the box narrows.
    let (rect, uv) = fit_source(box_16_9(), 640, 480, FitMode::Contain);
    assert_eq!(uv, UvRect::default(), "nothing is cropped");
    assert_eq!(rect.height, 180.0, "the height is already the limit");
    assert!((rect.width - 240.0).abs() < 1e-4, "width {}", rect.width);
    // And it stays centred in the box it was given.
    assert!((rect.x - (100.0 + (320.0 - 240.0) / 2.0)).abs() < 1e-4);
    assert_eq!(rect.y, 100.0);
  }

  #[test]
  fn contain_and_cover_both_preserve_the_source_aspect_ratio() {
    // The point of both modes, stated as the property rather than the numbers.
    for (w, h) in [(640u32, 480u32), (640, 320), (480, 640)] {
      let source_ratio = w as f32 / h as f32;

      // Contain shrinks the rect, so the rect itself has to take the source's
      // shape.
      let (contained, _) = fit_source(box_16_9(), w, h, FitMode::Contain);
      assert!((contained.width / contained.height - source_ratio).abs() < 1e-3);

      // Cover keeps the rect, so it is the *visible slice* of the source that
      // has to take the rect's shape instead.
      let (covered, uv) = fit_source(box_16_9(), w, h, FitMode::Cover);
      let shown_ratio = (w as f32 * uv.scale[0]) / (h as f32 * uv.scale[1]);
      assert!((shown_ratio - covered.width / covered.height).abs() < 1e-3);
    }
  }

  #[test]
  fn an_empty_box_survives_fitting() {
    // Zero size is the off switch, and contain divides by the box's ratio.
    let empty = Rect {
      x: 0.0,
      y: 0.0,
      width: 0.0,
      height: 0.0,
    };
    for fit in [FitMode::Stretch, FitMode::Cover, FitMode::Contain] {
      let (rect, uv) = fit_source(empty, 640, 480, fit);
      assert!(rect.is_empty());
      assert_eq!(uv, UvRect::default());
    }
  }

  #[test]
  fn opacity_above_one_is_clamped_rather_than_multiplied_in() {
    // It reaches the blend as source alpha, so 2.0 burns the feathered edge
    // instead of doing nothing.
    let layout = WebcamLayout {
      opacity: 2.0,
      corner_radius: -8.0,
      ..Default::default()
    }
    .sanitized();

    assert_eq!(layout.opacity, 1.0);
    assert_eq!(layout.corner_radius, 0.0);
  }

  #[test]
  fn a_non_finite_rect_is_flattened_to_nothing() {
    // NaN width would sail past `is_empty` and reach `to_ndc`.
    let layout = WebcamLayout {
      rect: Rect {
        x: 0.0,
        y: 0.0,
        width: f32::NAN,
        height: 100.0,
      },
      ..Default::default()
    }
    .sanitized();

    assert!(!layout.is_visible());
  }

  #[test]
  fn fit_names_fall_back_to_cover() {
    assert_eq!(FitMode::parse("stretch"), FitMode::Stretch);
    assert_eq!(FitMode::parse("fill"), FitMode::Stretch);
    assert_eq!(FitMode::parse("contain"), FitMode::Contain);
    assert_eq!(FitMode::parse("cover"), FitMode::Cover);
    // An unknown name gets the mode that cannot look visibly wrong.
    assert_eq!(FitMode::parse("banana"), FitMode::Cover);
  }

  #[test]
  fn a_track_holds_the_last_sample_rather_than_interpolating() {
    let track = CursorTrack::new(vec![sample(0.0, 0.0), sample(100.0, 1.0)]);

    assert_eq!(track.sample_at(0.0).unwrap().x, 0.0);
    // Half way between reports the pointer has not moved yet.
    assert_eq!(track.sample_at(50.0).unwrap().x, 0.0);
    assert_eq!(track.sample_at(100.0).unwrap().x, 1.0);
    // And it stays put past the end of the track.
    assert_eq!(track.sample_at(10_000.0).unwrap().x, 1.0);
  }

  #[test]
  fn there_is_no_cursor_before_the_first_sample() {
    let track = CursorTrack::new(vec![sample(500.0, 0.25)]);
    assert!(track.sample_at(499.0).is_none());
    assert!(track.sample_at(500.0).is_some());
  }

  #[test]
  fn a_sample_carries_the_bitmap_it_was_wearing() {
    // The point of the whole feature: the pointer's shape is a property of the
    // moment, not of the recording.
    let track = CursorTrack::new(vec![
      CursorSample {
        timestamp_ms: 0.0,
        image_id: Some(3),
        visible: true,
        ..Default::default()
      },
      CursorSample {
        timestamp_ms: 100.0,
        image_id: Some(7),
        visible: true,
        ..Default::default()
      },
    ]);

    assert_eq!(track.sample_at(50.0).unwrap().image_id, Some(3));
    assert_eq!(track.sample_at(150.0).unwrap().image_id, Some(7));
  }

  #[test]
  fn sorting_keeps_a_sample_with_its_own_bitmap() {
    // Samples are sorted on the way in. A sort that moved timestamps without
    // their ids would give every pointer the wrong shape, and only on tracks
    // that arrived out of order -- which is the hard kind of bug to notice.
    let track = CursorTrack::new(vec![
      CursorSample {
        timestamp_ms: 200.0,
        image_id: Some(2),
        visible: true,
        ..Default::default()
      },
      CursorSample {
        timestamp_ms: 0.0,
        image_id: Some(1),
        visible: true,
        ..Default::default()
      },
    ]);

    assert_eq!(track.sample_at(50.0).unwrap().image_id, Some(1));
    assert_eq!(track.sample_at(250.0).unwrap().image_id, Some(2));
  }

  #[test]
  fn a_sample_without_a_bitmap_asks_for_the_default() {
    let track = CursorTrack::new(vec![sample(0.0, 0.5)]);
    assert_eq!(track.sample_at(10.0).unwrap().image_id, None);
  }

  #[test]
  fn an_empty_table_has_nothing_at_any_id() {
    // The fallback path: no table set at all, which is what every caller from
    // before per-sample bitmaps looks like.
    let images = CursorImages::default();
    assert!(images.get(0).is_none());
    assert!(images.get(9).is_none());
  }

  #[test]
  fn a_hidden_sample_hides_the_cursor() {
    let track = CursorTrack::new(vec![
      sample(0.0, 0.0),
      CursorSample {
        timestamp_ms: 100.0,
        x: 1.0,
        y: 1.0,
        visible: false,
        image_id: None,
      },
    ]);

    assert!(track.sample_at(50.0).is_some());
    assert!(track.sample_at(150.0).is_none());
  }

  #[test]
  fn samples_are_sorted_on_the_way_in() {
    let track = CursorTrack::new(vec![
      sample(200.0, 1.0),
      sample(0.0, 0.0),
      sample(100.0, 0.5),
    ]);
    assert_eq!(track.len(), 3);
    assert_eq!(track.sample_at(150.0).unwrap().x, 0.5);
  }
}
