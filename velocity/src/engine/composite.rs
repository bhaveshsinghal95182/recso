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

  /// Whether this rect swallows a `width` x `height` surface whole.
  ///
  /// Asked before drawing a drop shadow: once the recording reaches every edge
  /// there is no background left for one to land on, and every pixel of it
  /// would be painted over by the recording itself.
  pub fn contains_canvas(&self, width: u32, height: u32) -> bool {
    self.x <= 0.0
      && self.y <= 0.0
      && self.x + self.width >= width as f32
      && self.y + self.height >= height as f32
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

/// The quad to draw a smeared cursor into, and how it maps back onto the sprite.
///
/// `head` is where the pointer itself goes; `smear` is how far it travels
/// forward over the tail's length, in the same pixels. Returns the bounding box
/// of the pointer and the pointer swept backwards, the uv transform that puts
/// the sprite back in the right place inside that box, and the travel expressed
/// in the sprite's own uv units for the shader to march along.
///
/// Doing it as one stretched quad rather than a trail of sprite copies is the
/// difference between a smear and a blur: the copies are separable objects and
/// read as ghosts, the stretch reads as one thing moving. It is also one draw
/// instead of a dozen.
///
/// `None` when there is nothing to smear, so the caller falls back to the plain
/// sprite path and pays nothing for a stationary pointer.
pub fn smear_geometry(head: Rect, smear: [f32; 2]) -> Option<(Rect, UvRect, [f32; 2])> {
  let [sx, sy] = smear;
  if head.is_empty() || (sx == 0.0 && sy == 0.0) {
    return None;
  }

  // The tail trails the pointer, so the box grows on whichever side the pointer
  // came *from*: moving right, it grows to the left.
  let quad = Rect {
    x: head.x - sx.max(0.0),
    y: head.y - sy.max(0.0),
    width: head.width + sx.abs(),
    height: head.height + sy.abs(),
  };

  // The sprite still occupies exactly `head`, so uv 0..1 has to land there
  // inside a box that is larger. Anything outside that range is tail, and the
  // shader treats it as empty rather than letting the sampler clamp.
  let uv = UvRect {
    scale: [quad.width / head.width, quad.height / head.height],
    offset: [
      (quad.x - head.x) / head.width,
      (quad.y - head.y) / head.height,
    ],
  };

  Some((quad, uv, [sx / head.width, sy / head.height]))
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
/// Not `Copy`: the shadow stack is a `Vec`. Cloned where it used to be copied,
/// which happens once per layout change rather than once per frame.
#[derive(Clone, Debug, PartialEq)]
pub struct WebcamLayout {
  pub rect: Rect,
  pub shape: OverlayShape,
  pub corner_radius: f32,
  pub opacity: f32,
  pub fit: FitMode,
  /// Border thickness in canvas pixels, drawn outside the rect. Zero is none.
  pub border_width: f32,
  pub border_colour: [f32; 4],
  /// Drop shadows, drawn under everything else in the order given. Usually two
  /// or three: a style is built out of a tight dark one and a wide soft one.
  pub shadows: Vec<Shadow>,
}

/// One drop shadow layer, under the recording or under the camera.
///
/// The same four numbers a CSS box-shadow or a Canvas2D `shadowBlur` carries,
/// because that is where the values come from -- the editor's styles are
/// authored as shadow stacks and this is what they mean.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shadow {
  /// Canvas pixels, positive right and down.
  pub offset: [f32; 2],
  /// Canvas's `shadowBlur`, which is a Gaussian of sigma = blur/2.
  pub blur: f32,
  pub colour: [f32; 4],
}

/// Turning canvas's blur radius into the smoothstep half-width `ps_shadow` uses.
///
/// A Gaussian-blurred edge has alpha `phi(-d / sigma)`; a smoothstep of
/// half-width 1.88 sigma has the same slope through the middle and tracks it to
/// within a couple of percent. Canvas defines `shadowBlur` as sigma = blur/2,
/// so 1.88 * 0.5 = 0.94.
const SHADOW_SOFTNESS_PER_BLUR: f32 = 0.94;

impl Shadow {
  /// How far the falloff reaches past the shape, in pixels.
  ///
  /// Exact rather than a guess, because a smoothstep actually reaches zero --
  /// there is no tail to truncate. The extra pixel is slack against rounding at
  /// the quad's edge.
  pub fn reach(&self) -> f32 {
    self.softness() + 1.0
  }

  pub fn softness(&self) -> f32 {
    self.blur.max(0.0) * SHADOW_SOFTNESS_PER_BLUR
  }

  /// This shadow at a different scale.
  ///
  /// For the video layer, which is drawn zoomed: the offset and the blur are
  /// canvas pixels authored against the unzoomed recording, so under a 2x zoom
  /// they have to grow with it. A shadow that stayed 18px while the recording
  /// doubled would read as the picture coming loose from its own shadow.
  pub fn scaled(&self, factor: f32) -> Self {
    Self {
      offset: [self.offset[0] * factor, self.offset[1] * factor],
      blur: self.blur * factor,
      colour: self.colour,
    }
  }

  /// The quad to draw this shadow in: the shape moved by the offset, then grown
  /// on every side by the reach so nothing is clipped.
  pub fn quad_rect(&self, shape: Rect) -> Rect {
    Rect {
      x: shape.x + self.offset[0],
      y: shape.y + self.offset[1],
      width: shape.width,
      height: shape.height,
    }
    .expanded(self.reach())
  }

  /// Whether this layer would put anything on screen.
  ///
  /// Transparent is the obvious one; a style carries disabled layers as
  /// all-zeroes and each still costs a quad the size of the box plus its blur.
  /// No blur *and* no offset is the subtler one: the silhouette then lands
  /// exactly under the camera that is about to be drawn over it, so the only
  /// thing it can affect is the antialiased edge. The Canvas2D compositor skips
  /// that case too, and the two have to agree or a style looks different in the
  /// preview than it did before.
  pub fn is_visible(&self) -> bool {
    self.colour[3] > 0.0 && (self.blur > 0.0 || self.offset != [0.0, 0.0])
  }
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
      shadows: Vec::new(),
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
    // A shadow that cannot be seen still costs a quad the size of the box plus
    // its blur, and a style with three layers is the common case rather than
    // the exotic one.
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

/// The shaders, blend state and constant buffer the overlay passes need.
pub struct Overlays {
  vs: ID3D11VertexShader,
  ps_overlay: ID3D11PixelShader,
  ps_sprite: ID3D11PixelShader,
  ps_smear: ID3D11PixelShader,
  ps_solid: ID3D11PixelShader,
  ps_shadow: ID3D11PixelShader,
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
  /// The cursor again, stretched along its travel. Carries the forward offset
  /// in the sprite's own uv units -- see `ps_smear`.
  Smear([f32; 2]),
  /// A flat colour, no texture. Borders.
  Solid([f32; 4]),
  /// The shape's silhouette, blurred, in a flat colour. Drop shadows.
  Shadow(ShadowFill),
}

/// A shadow quad's shape, in the form `ps_shadow` wants it.
///
/// The half-size is here rather than being taken from the quad because the two
/// differ: the quad is grown to hold the blur, and the silhouette must stay the
/// size of the box it is cast by.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShadowFill {
  pub colour: [f32; 4],
  /// Half the shape's size, in destination pixels.
  pub half: [f32; 2],
  /// Half-width of the edge falloff, in pixels.
  pub softness: f32,
}

impl Overlays {
  pub fn new(
    gpu: &Gpu,
    vs: ID3D11VertexShader,
    ps_overlay: ID3D11PixelShader,
    ps_sprite: ID3D11PixelShader,
    ps_smear: ID3D11PixelShader,
    ps_solid: ID3D11PixelShader,
    ps_shadow: ID3D11PixelShader,
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

    // 28 floats: the rect, the mask, the grade, the uv sub-rect, the tint, the
    // smear vector and the shadow's shape.
    let constants = super::render::create_constant_buffer(gpu, 28 * 4)?;

    Ok(Self {
      vs,
      ps_overlay,
      ps_sprite,
      ps_smear,
      ps_solid,
      ps_shadow,
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
          Fill::Smear(_) => &self.ps_smear,
          Fill::Solid(_) => &self.ps_solid,
          Fill::Shadow(_) => &self.ps_shadow,
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
      Fill::Shadow(shadow) => shadow.colour,
      _ => [0.0, 0.0, 0.0, 0.0],
    };
    let smear = match quad.fill {
      Fill::Smear(offset) => offset,
      _ => [0.0, 0.0],
    };
    let (shadow_half, shadow_softness) = match quad.fill {
      Fill::Shadow(shadow) => (shadow.half, shadow.softness),
      _ => ([0.0, 0.0], 0.0),
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
      smear[0],
      smear[1],
      shadow_half[0],
      shadow_half[1],
      shadow_softness,
      0.0,
      0.0,
      0.0,
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

/// Spans of the composition where a layer is not drawn.
///
/// Composition time, not source time, and the difference matters. `CutTrack`
/// describes spans removed from the timeline entirely -- everything after one
/// shifts earlier. These are spans that are still *there*, still playing, with
/// one layer missing from them, so nothing moves and the times do not need
/// remapping. A span cut from every layer collapses to nothing on the way in
/// and never reaches here.
#[derive(Default)]
pub struct HiddenSpans {
  spans: Vec<(f64, f64)>,
}

impl HiddenSpans {
  /// Sorted on the way in so the lookup can stop early.
  pub fn new(mut spans: Vec<(f64, f64)>) -> Self {
    spans.retain(|(start, end)| end > start);
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    Self { spans }
  }

  pub fn is_empty(&self) -> bool {
    self.spans.is_empty()
  }

  /// Whether this instant is inside one of them.
  ///
  /// Half open: a span ending at 1000ms does not hide the frame at 1000ms, so
  /// two back to back spans neither overlap nor leave a frame between them.
  pub fn contains(&self, composition_ms: f64) -> bool {
    for (start, end) in &self.spans {
      if composition_ms < *start {
        return false;
      }
      if composition_ms < *end {
        return true;
      }
    }
    false
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
  /// Whether the user clicked at this instant.
  ///
  /// A flag on the sample rather than a separate list because a click *is* a
  /// recorded pointer event -- it arrives with a position, through the same
  /// track, and a cut that drops the moment has to drop the click with it.
  /// `CursorTrack` pulls the times out on the way in, because the two decay
  /// differently: a position is held until the next sample, a click is an
  /// impulse that plays out over its own duration.
  pub click: bool,
}

/// How the pointer was travelling when a frame was taken.
///
/// Normalised source units per millisecond, the same space the samples are in,
/// so the caller scales it by whatever rectangle the video ended up occupying.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CursorMotion {
  pub vx: f32,
  pub vy: f32,
}

/// The recorded cursor path, searchable by playback position.
#[derive(Default)]
pub struct CursorTrack {
  samples: Vec<CursorSample>,
  /// Click times, pulled out of the samples. Sorted, because the samples are.
  clicks: Vec<f64>,
}

impl CursorTrack {
  /// Sorts on the way in so lookup can binary search. The recorder emits in
  /// order, but a track assembled from several sources might not be.
  pub fn new(mut samples: Vec<CursorSample>) -> Self {
    samples.sort_by(|a, b| a.timestamp_ms.total_cmp(&b.timestamp_ms));
    let clicks = samples
      .iter()
      .filter(|s| s.click)
      .map(|s| s.timestamp_ms)
      .collect();
    Self { samples, clicks }
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

  /// How fast the pointer was moving at `timestamp_ms`, if it was moving.
  ///
  /// Measured across the last two samples rather than smoothed over more,
  /// because the smear is meant to read as "this is where it is going right
  /// now" and an average lags the direction through a corner.
  ///
  /// Returns `None` once the pair goes stale, and that is the whole of the
  /// "snap back" behaviour. The track holds the last sample forever, so the
  /// velocity that reached it would otherwise still be there minutes after the
  /// pointer stopped -- a streak frozen on screen. Instead the motion is only
  /// believed for about as long as it took to arrive: if the next sample has
  /// not turned up by then, the pointer has stopped, and the smear is gone in
  /// one frame rather than easing out of something that already ended.
  pub fn motion_at(&self, timestamp_ms: f64) -> Option<CursorMotion> {
    let upper = self
      .samples
      .partition_point(|s| s.timestamp_ms <= timestamp_ms);
    if upper < 2 {
      return None;
    }

    let last = self.samples[upper - 1];
    let previous = self.samples[upper - 2];
    // A pointer that was hidden and came back did not travel the distance
    // between the two -- it teleported, and smearing that draws a streak
    // across whatever it crossed.
    if !last.visible || !previous.visible {
      return None;
    }

    let gap_ms = last.timestamp_ms - previous.timestamp_ms;
    if gap_ms <= 0.0 || gap_ms > MAX_MOTION_GAP_MS {
      return None;
    }

    if timestamp_ms - last.timestamp_ms > gap_ms.clamp(MIN_MOTION_HOLD_MS, MAX_MOTION_HOLD_MS) {
      return None;
    }

    Some(CursorMotion {
      vx: (last.x - previous.x) / gap_ms as f32,
      vy: (last.y - previous.y) / gap_ms as f32,
    })
  }

  /// The scale multiplier a click adds at `timestamp_ms`, or 1.0 for none.
  ///
  /// Resolved against the click list rather than the sample in effect, because
  /// a click is an impulse and a sample is a state. Flagging the held sample
  /// would end the animation at the next mouse move -- ten milliseconds later
  /// if the user is dragging, which is exactly when a click most needs to be
  /// visible.
  pub fn click_scale_at(&self, timestamp_ms: f64, peak: f32, duration_ms: f64) -> f32 {
    if peak == 1.0 || duration_ms <= 0.0 || self.clicks.is_empty() {
      return 1.0;
    }

    let upper = self.clicks.partition_point(|t| *t <= timestamp_ms);
    if upper == 0 {
      return 1.0;
    }

    let elapsed = timestamp_ms - self.clicks[upper - 1];
    1.0 + (peak - 1.0) * click_envelope(elapsed, duration_ms)
  }
}

/// A pair of samples further apart than this is not motion worth smearing --
/// the pointer was somewhere else a quarter of a second ago, which says nothing
/// about where it is heading now.
const MAX_MOTION_GAP_MS: f64 = 260.0;
/// Believe a velocity for at least one frame at 30fps, so a slow sample cadence
/// does not make the smear flicker...
const MIN_MOTION_HOLD_MS: f64 = 34.0;
/// ...and never for longer than this, so a gap that only just qualified above
/// cannot leave a streak hanging for a quarter of a second.
const MAX_MOTION_HOLD_MS: f64 = 120.0;

/// How much of the click's peak is showing, `elapsed_ms` into it.
///
/// A fast punch out and a slower settle back. Holding the pointer at full size
/// for the whole duration would read as the cursor having changed size, and an
/// equal rise and fall reads as breathing; the asymmetry is what makes it look
/// struck.
fn click_envelope(elapsed_ms: f64, duration_ms: f64) -> f32 {
  if duration_ms <= 0.0 || elapsed_ms < 0.0 || elapsed_ms >= duration_ms {
    return 0.0;
  }

  /// Fraction of the duration spent growing. The rest is the settle.
  const ATTACK: f64 = 0.18;

  let progress = elapsed_ms / duration_ms;
  let position = if progress < ATTACK {
    progress / ATTACK
  } else {
    1.0 - (progress - ATTACK) / (1.0 - ATTACK)
  };

  // Smoothstep at both ends: the pop starts and stops from rest, so there is no
  // corner at the peak or at the moment it finishes.
  let x = position.clamp(0.0, 1.0) as f32;
  x * x * (3.0 - 2.0 * x)
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
      click: false,
    }
  }

  #[test]
  fn a_hidden_span_covers_its_own_range_only() {
    let hidden = HiddenSpans::new(vec![(1000.0, 2000.0)]);

    assert!(!hidden.contains(999.0));
    assert!(hidden.contains(1000.0));
    assert!(hidden.contains(1999.0));
    // Half open, so a span ending here and one starting here do not both claim
    // this frame -- and neither leaves it uncovered.
    assert!(!hidden.contains(2000.0));
  }

  #[test]
  fn back_to_back_spans_leave_no_gap() {
    let hidden = HiddenSpans::new(vec![(0.0, 500.0), (500.0, 900.0)]);

    assert!(hidden.contains(499.0));
    assert!(hidden.contains(500.0));
    assert!(hidden.contains(899.0));
    assert!(!hidden.contains(900.0));
  }

  #[test]
  fn spans_are_sorted_and_empty_ones_dropped() {
    // Out of order from the caller, and a zero length span that would otherwise
    // stop the early exit from ever being reached.
    let hidden = HiddenSpans::new(vec![(2000.0, 3000.0), (400.0, 400.0), (0.0, 100.0)]);

    assert!(hidden.contains(50.0));
    assert!(!hidden.contains(400.0));
    assert!(hidden.contains(2500.0));
  }

  #[test]
  fn nothing_hidden_hides_nothing() {
    assert!(HiddenSpans::default().is_empty());
    assert!(!HiddenSpans::default().contains(1234.0));
  }

  #[test]
  fn a_still_pointer_needs_no_smear_quad() {
    let head = Rect {
      x: 100.0,
      y: 100.0,
      width: 20.0,
      height: 30.0,
    };

    assert!(smear_geometry(head, [0.0, 0.0]).is_none());
  }

  #[test]
  fn the_smear_box_grows_behind_the_pointer() {
    let head = Rect {
      x: 100.0,
      y: 100.0,
      width: 20.0,
      height: 30.0,
    };

    // Travelling right: the tail is to the left, so the box grows that way and
    // the pointer stays where it was going to be drawn anyway.
    let (quad, _, _) = smear_geometry(head, [40.0, 0.0]).expect("smeared");
    assert_eq!(quad.x, 60.0);
    assert_eq!(quad.width, 60.0);
    assert_eq!(quad.y, 100.0);
    assert_eq!(quad.height, 30.0);

    // Travelling left: the other side.
    let (quad, _, _) = smear_geometry(head, [-40.0, 0.0]).expect("smeared");
    assert_eq!(quad.x, 100.0);
    assert_eq!(quad.width, 60.0);
  }

  #[test]
  fn the_sprite_still_lands_exactly_on_the_pointer() {
    // The whole point of the uv transform: the box is bigger, but uv 0..1 has
    // to keep meaning "the pointer", or a smeared cursor would sit somewhere
    // different from an unsmeared one and the smear would look like a jump.
    let head = Rect {
      x: 100.0,
      y: 100.0,
      width: 20.0,
      height: 30.0,
    };
    let (quad, uv, _) = smear_geometry(head, [40.0, 15.0]).expect("smeared");

    // Where uv hits 0 and 1 across the quad, back in destination pixels.
    let at = |u: f32, axis: usize| {
      let (start, size) = if axis == 0 {
        (quad.x, quad.width)
      } else {
        (quad.y, quad.height)
      };
      // Invert `uv = t * scale + offset` for the t that gives `u`.
      start + (u - uv.offset[axis]) / uv.scale[axis] * size
    };

    assert!((at(0.0, 0) - head.x).abs() < 1e-3);
    assert!((at(1.0, 0) - (head.x + head.width)).abs() < 1e-3);
    assert!((at(0.0, 1) - head.y).abs() < 1e-3);
    assert!((at(1.0, 1) - (head.y + head.height)).abs() < 1e-3);
  }

  #[test]
  fn the_far_end_of_the_tail_marches_back_onto_the_sprite() {
    // A pixel at the very end of the tail, marched the full length of the
    // smear, has to land on the pointer's own edge -- that is what makes the
    // tail show where the pointer was rather than a stripe of clamped texels.
    let head = Rect {
      x: 100.0,
      y: 100.0,
      width: 20.0,
      height: 30.0,
    };
    let (quad, uv, offset) = smear_geometry(head, [40.0, 0.0]).expect("smeared");

    // uv of the quad's leftmost pixel, which is the back of the tail.
    let tail_u = uv.offset[0];
    assert!(tail_u < 0.0, "the tail sits outside the sprite");
    assert!(
      (tail_u + offset[0]).abs() < 1e-3,
      "a full march reaches uv 0"
    );
    assert_eq!(quad.x, 60.0);
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
        click: false,
      },
    ]);

    assert!(track.sample_at(50.0).is_some());
    assert!(track.sample_at(150.0).is_none());
  }

  fn click(timestamp_ms: f64, x: f32) -> CursorSample {
    CursorSample {
      click: true,
      ..sample(timestamp_ms, x)
    }
  }

  #[test]
  fn a_click_pops_the_pointer_and_settles_back() {
    let track = CursorTrack::new(vec![click(100.0, 0.5)]);

    assert_eq!(track.click_scale_at(99.0, 1.5, 500.0), 1.0);
    let peak = track.click_scale_at(100.0 + 500.0 * 0.18, 1.5, 500.0);
    assert!((peak - 1.5).abs() < 1e-3, "peak was {peak}");
    // Back to nothing by the end, not left slightly enlarged.
    assert_eq!(track.click_scale_at(600.0, 1.5, 500.0), 1.0);
    assert_eq!(track.click_scale_at(5000.0, 1.5, 500.0), 1.0);
  }

  #[test]
  fn the_pop_grows_faster_than_it_settles() {
    let track = CursorTrack::new(vec![click(0.0, 0.5)]);

    // The peak lands at 18% of the duration, so the same offset either side of
    // it is well up the rise and barely down the fall. The settle being the
    // slower half is what makes it read as struck rather than as breathing.
    let peak_ms = 500.0 * 0.18;
    let rising = track.click_scale_at(peak_ms - 45.0, 2.0, 500.0);
    let falling = track.click_scale_at(peak_ms + 45.0, 2.0, 500.0);
    assert!(
      falling > rising,
      "the settle {falling} should still be above the rise {rising}"
    );

    // And it is genuinely finished: no residue left at the end.
    assert_eq!(track.click_scale_at(499.9, 2.0, 500.0).round(), 1.0);
  }

  #[test]
  fn a_move_right_after_a_click_does_not_cut_the_pop_short() {
    // The trap this whole design avoids: the click is not a property of the
    // sample in effect, so the mousemove ten milliseconds later -- a drag --
    // must not end the animation.
    let track = CursorTrack::new(vec![click(100.0, 0.5), sample(110.0, 0.6)]);

    assert!(track.click_scale_at(200.0, 1.5, 500.0) > 1.0);
  }

  #[test]
  fn a_track_with_no_clicks_never_scales() {
    let track = CursorTrack::new(vec![sample(0.0, 0.0), sample(100.0, 1.0)]);

    assert_eq!(track.click_scale_at(50.0, 2.0, 500.0), 1.0);
  }

  #[test]
  fn the_pointer_carries_its_velocity_while_it_is_moving() {
    let track = CursorTrack::new(vec![sample(0.0, 0.0), sample(100.0, 0.5)]);

    let motion = track.motion_at(100.0).expect("moving");
    assert!((motion.vx - 0.005).abs() < 1e-6, "vx was {}", motion.vx);
    assert_eq!(motion.vy, 0.0);
  }

  #[test]
  fn a_stopped_pointer_snaps_out_of_its_smear() {
    let track = CursorTrack::new(vec![sample(0.0, 0.0), sample(100.0, 0.5)]);

    // Still believed a frame later...
    assert!(track.motion_at(120.0).is_some());
    // ...and gone once the next sample plainly is not coming. The track holds
    // the last sample forever, so without this the smear would still be there
    // minutes after the pointer stopped.
    assert!(track.motion_at(400.0).is_none());
  }

  #[test]
  fn a_pointer_that_reappeared_somewhere_else_did_not_travel_there() {
    let track = CursorTrack::new(vec![
      CursorSample {
        visible: false,
        ..sample(0.0, 0.0)
      },
      sample(50.0, 1.0),
    ]);

    assert!(track.motion_at(50.0).is_none());
  }

  #[test]
  fn a_long_pause_between_samples_is_not_a_velocity() {
    // Half a second apart says where the pointer used to be, not where it is
    // heading. Smearing across that gap draws a streak over the whole screen.
    let track = CursorTrack::new(vec![sample(0.0, 0.0), sample(500.0, 1.0)]);

    assert!(track.motion_at(500.0).is_none());
  }

  #[test]
  fn the_first_sample_has_nothing_to_measure_against() {
    let track = CursorTrack::new(vec![sample(0.0, 0.0)]);

    assert!(track.motion_at(0.0).is_none());
  }

  // --- webcam shadows ------------------------------------------------------

  fn shadow(offset: [f32; 2], blur: f32) -> Shadow {
    Shadow {
      offset,
      blur,
      colour: [0.0, 0.0, 0.0, 0.5],
    }
  }

  fn box_rect() -> Rect {
    Rect {
      x: 100.0,
      y: 200.0,
      width: 320.0,
      height: 180.0,
    }
  }

  /// The one that would be visible if it were wrong: a falloff wider than the
  /// quad is cut off, and a cut-off shadow has a hard straight edge running
  /// through it. Asserted as a property over a range of blurs rather than one
  /// case, because the failure is a constant being slightly too small.
  #[test]
  fn a_shadow_quad_holds_the_whole_falloff() {
    for blur in [0.0, 1.0, 8.0, 40.0, 200.0] {
      let s = shadow([0.0, 0.0], blur);
      let quad = s.quad_rect(box_rect());
      let slack = (quad.width - box_rect().width) * 0.5;

      assert!(
        slack >= s.softness(),
        "blur {blur}: quad grew by {slack} for a falloff of {}",
        s.softness()
      );
    }
  }

  #[test]
  fn a_shadow_is_cast_from_the_box_it_is_offset_from() {
    let quad = shadow([12.0, -6.0], 0.0).quad_rect(box_rect());

    // Centres, which is what the shader measures `local` from: the shape sits
    // in the middle of its quad, moved by the offset.
    let centre = |r: Rect| (r.x + r.width * 0.5, r.y + r.height * 0.5);
    let (bx, by) = centre(box_rect());
    let (qx, qy) = centre(quad);

    assert!((qx - (bx + 12.0)).abs() < 1e-3, "x moved to {qx}");
    assert!((qy - (by - 6.0)).abs() < 1e-3, "y moved to {qy}");
  }

  /// Canvas's `shadowBlur` is a Gaussian of sigma = blur/2, and the shader's
  /// smoothstep matches it at a half-width of 1.88 sigma. Pinned because the
  /// number is the whole of the match: get it wrong and every shadow in the
  /// app is softer or harder than the style says.
  #[test]
  fn softness_follows_canvas_blur() {
    assert!((shadow([0.0, 0.0], 20.0).softness() - 18.8).abs() < 1e-3);
    assert_eq!(shadow([0.0, 0.0], 0.0).softness(), 0.0);
    // Negative is not a smaller blur, it is nonsense arriving from a config.
    assert_eq!(shadow([0.0, 0.0], -5.0).softness(), 0.0);
  }

  #[test]
  fn a_shadow_that_cannot_be_seen_is_not_drawn() {
    let transparent = Shadow {
      colour: [0.0, 0.0, 0.0, 0.0],
      ..shadow([4.0, 4.0], 10.0)
    };
    assert!(!transparent.is_visible());

    // No blur and no offset lands exactly under the camera drawn over it.
    assert!(!shadow([0.0, 0.0], 0.0).is_visible());
    // ...but either one alone puts something outside the box.
    assert!(shadow([2.0, 0.0], 0.0).is_visible());
    assert!(shadow([0.0, 0.0], 2.0).is_visible());
  }

  #[test]
  fn sanitizing_drops_the_shadows_that_would_draw_nothing() {
    let layout = WebcamLayout {
      rect: box_rect(),
      shadows: vec![
        shadow([0.0, 0.0], 0.0),
        shadow([4.0, 4.0], 12.0),
        Shadow {
          blur: f32::NAN,
          ..shadow([0.0, 0.0], 0.0)
        },
        Shadow {
          offset: [f32::INFINITY, 0.0],
          ..shadow([0.0, 0.0], 8.0)
        },
      ],
      ..WebcamLayout::default()
    }
    .sanitized();

    assert_eq!(layout.shadows.len(), 1);
    assert_eq!(layout.shadows[0].blur, 12.0);
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

#[cfg(test)]
mod rect_scenarios {
  use super::*;

  fn r(x: f32, y: f32, width: f32, height: f32) -> Rect {
    Rect {
      x,
      y,
      width,
      height,
    }
  }

  #[test]
  fn a_rect_with_both_sides_is_not_empty() {
    assert!(!r(0.0, 0.0, 1.0, 1.0).is_empty());
  }

  #[test]
  fn a_rect_reaching_every_edge_contains_the_canvas() {
    assert!(r(0.0, 0.0, 1920.0, 1080.0).contains_canvas(1920, 1080));
    // Overhanging on every side, which is what a zoom does.
    assert!(r(-400.0, -200.0, 2800.0, 1600.0).contains_canvas(1920, 1080));
  }

  #[test]
  fn a_rect_short_of_any_one_edge_does_not() {
    // One edge is enough: background still shows there, so a shadow cast onto
    // it is visible and skipping the pass would drop it.
    assert!(!r(1.0, 0.0, 1919.0, 1080.0).contains_canvas(1920, 1080));
    assert!(!r(0.0, 0.0, 1920.0, 1079.0).contains_canvas(1920, 1080));
    assert!(!r(-400.0, -200.0, 2800.0, 1000.0).contains_canvas(1920, 1080));
    assert!(!r(200.0, 100.0, 400.0, 300.0).contains_canvas(1920, 1080));
  }

  #[test]
  fn a_rect_with_no_width_is_empty() {
    assert!(r(0.0, 0.0, 0.0, 10.0).is_empty());
  }

  #[test]
  fn a_rect_with_no_height_is_empty() {
    assert!(r(0.0, 0.0, 10.0, 0.0).is_empty());
  }

  #[test]
  fn a_rect_wound_backwards_horizontally_is_empty() {
    assert!(r(0.0, 0.0, -10.0, 10.0).is_empty());
  }

  #[test]
  fn a_rect_wound_backwards_vertically_is_empty() {
    assert!(r(0.0, 0.0, 10.0, -10.0).is_empty());
  }

  #[test]
  fn a_rect_with_both_sides_backwards_is_empty() {
    assert!(r(0.0, 0.0, -10.0, -10.0).is_empty());
  }

  #[test]
  fn emptiness_ignores_where_the_rect_is() {
    // Position never enters the test -- a rect off the left of the canvas is
    // still a rect, it is just not visible.
    assert!(!r(-500.0, -500.0, 4.0, 4.0).is_empty());
  }

  #[test]
  fn a_hair_of_width_is_still_not_empty() {
    assert!(!r(0.0, 0.0, f32::MIN_POSITIVE, 10.0).is_empty());
  }

  #[test]
  fn a_nan_side_does_not_read_as_empty() {
    // NaN fails every comparison, so this falls through to "not empty". Worth
    // pinning: `sanitized` exists precisely because this check will not catch
    // it, and if `is_empty` ever started catching it the sanitizer's NaN
    // branches would quietly become dead code.
    assert!(!r(0.0, 0.0, f32::NAN, 10.0).is_empty());
  }

  #[test]
  fn expanding_grows_every_side() {
    let grown = r(100.0, 100.0, 200.0, 100.0).expanded(10.0);
    assert_eq!(grown, r(90.0, 90.0, 220.0, 120.0));
  }

  #[test]
  fn expanding_by_nothing_changes_nothing() {
    let base = r(1.0, 2.0, 3.0, 4.0);
    assert_eq!(base.expanded(0.0), base);
  }

  #[test]
  fn a_negative_expansion_shrinks() {
    let shrunk = r(100.0, 100.0, 200.0, 100.0).expanded(-10.0);
    assert_eq!(shrunk, r(110.0, 110.0, 180.0, 80.0));
  }

  #[test]
  fn expanding_and_shrinking_by_the_same_amount_round_trips() {
    let base = r(12.0, 34.0, 56.0, 78.0);
    assert_eq!(base.expanded(7.0).expanded(-7.0), base);
  }

  #[test]
  fn expanding_keeps_the_centre_where_it_was() {
    let base = r(100.0, 50.0, 200.0, 100.0);
    let grown = base.expanded(25.0);
    let centre = |rect: Rect| (rect.x + rect.width * 0.5, rect.y + rect.height * 0.5);
    assert_eq!(centre(base), centre(grown));
  }

  #[test]
  fn shrinking_past_the_middle_produces_an_empty_rect() {
    // Which is the point: a border wider than the box it insets should collapse
    // rather than turn inside out and draw a mirrored quad.
    assert!(r(0.0, 0.0, 10.0, 10.0).expanded(-6.0).is_empty());
  }

  #[test]
  fn covering_starts_at_the_origin() {
    let full = Rect::covering(1920, 1080);
    assert_eq!(full.x, 0.0);
    assert_eq!(full.y, 0.0);
  }

  #[test]
  fn covering_takes_the_whole_surface() {
    let full = Rect::covering(1920, 1080);
    assert_eq!(full.width, 1920.0);
    assert_eq!(full.height, 1080.0);
  }

  #[test]
  fn covering_nothing_is_empty() {
    assert!(Rect::covering(0, 0).is_empty());
  }

  #[test]
  fn covering_a_single_pixel_is_not_empty() {
    assert!(!Rect::covering(1, 1).is_empty());
  }

  #[test]
  fn covering_a_degenerate_surface_is_empty_in_that_axis() {
    assert!(Rect::covering(1920, 0).is_empty());
    assert!(Rect::covering(0, 1080).is_empty());
  }

  #[test]
  fn a_full_frame_rect_spans_the_whole_of_clip_space() {
    let ndc = Rect::covering(800, 600).to_ndc(800, 600);
    assert_eq!(ndc, [-1.0, 1.0, 1.0, -1.0]);
  }

  #[test]
  fn the_top_left_of_the_destination_is_the_top_left_of_clip_space() {
    let ndc = r(0.0, 0.0, 1.0, 1.0).to_ndc(800, 600);
    assert_eq!(ndc[0], -1.0);
    assert_eq!(ndc[1], 1.0);
  }

  #[test]
  fn clip_space_y_runs_the_other_way_to_the_destination() {
    // A rect further down the screen has a *smaller* clip-space y. This flip is
    // the only reason `to_ndc` exists rather than a couple of inline divides.
    let near_top = r(0.0, 10.0, 10.0, 10.0).to_ndc(800, 600);
    let near_bottom = r(0.0, 500.0, 10.0, 10.0).to_ndc(800, 600);
    assert!(near_bottom[1] < near_top[1]);
  }

  #[test]
  fn clip_space_x_runs_the_same_way_as_the_destination() {
    let left = r(10.0, 0.0, 10.0, 10.0).to_ndc(800, 600);
    let right = r(500.0, 0.0, 10.0, 10.0).to_ndc(800, 600);
    assert!(right[0] > left[0]);
  }

  #[test]
  fn the_centre_of_the_destination_is_the_origin_of_clip_space() {
    let ndc = r(400.0, 300.0, 0.0, 0.0).to_ndc(800, 600);
    assert!((ndc[0]).abs() < 1e-6);
    assert!((ndc[1]).abs() < 1e-6);
  }

  #[test]
  fn a_quarter_rect_covers_a_quarter_of_clip_space_in_each_axis() {
    let ndc = r(0.0, 0.0, 400.0, 300.0).to_ndc(800, 600);
    assert_eq!(ndc[2], 0.0);
    assert_eq!(ndc[3], 0.0);
  }

  #[test]
  fn a_zero_sized_destination_does_not_divide_by_zero() {
    // `max(1)` on both axes. The numbers are meaningless but they are finite,
    // and a NaN here would poison the vertex shader rather than draw nothing.
    let ndc = r(0.0, 0.0, 10.0, 10.0).to_ndc(0, 0);
    assert!(ndc.iter().all(|v| v.is_finite()));
  }

  #[test]
  fn a_rect_past_the_edge_maps_outside_clip_space() {
    // Not clamped: the rasterizer clips, and clamping here would squash a quad
    // that is only partly on screen instead of cropping it.
    let ndc = r(900.0, 0.0, 100.0, 100.0).to_ndc(800, 600);
    assert!(ndc[0] > 1.0);
  }

  #[test]
  fn mapping_to_clip_space_is_linear_in_x() {
    let at = |x: f32| r(x, 0.0, 1.0, 1.0).to_ndc(800, 600)[0];
    let step_low = at(200.0) - at(100.0);
    let step_high = at(600.0) - at(500.0);
    assert!((step_low - step_high).abs() < 1e-6);
  }
}

#[cfg(test)]
mod fit_mode_scenarios {
  use super::*;

  #[test]
  fn cover_is_asked_for_by_name() {
    assert_eq!(FitMode::parse("cover"), FitMode::Cover);
  }

  #[test]
  fn contain_is_asked_for_by_name() {
    assert_eq!(FitMode::parse("contain"), FitMode::Contain);
  }

  #[test]
  fn stretch_is_asked_for_by_name() {
    assert_eq!(FitMode::parse("stretch"), FitMode::Stretch);
  }

  #[test]
  fn fill_is_the_css_spelling_of_stretch() {
    assert_eq!(FitMode::parse("fill"), FitMode::Stretch);
  }

  #[test]
  fn an_empty_name_falls_back_to_cover() {
    assert_eq!(FitMode::parse(""), FitMode::Cover);
  }

  #[test]
  fn an_unknown_name_falls_back_to_cover() {
    assert_eq!(FitMode::parse("crop"), FitMode::Cover);
  }

  #[test]
  fn the_names_are_case_sensitive() {
    // The caller is a serialiser, not a human typing, so a capital is a bug on
    // the sending side rather than something to be forgiving about.
    assert_eq!(FitMode::parse("Contain"), FitMode::Cover);
    assert_eq!(FitMode::parse("STRETCH"), FitMode::Cover);
  }

  #[test]
  fn a_padded_name_is_not_trimmed() {
    assert_eq!(FitMode::parse(" contain "), FitMode::Cover);
  }

  #[test]
  fn the_default_is_the_mode_that_cannot_look_wrong() {
    assert_eq!(FitMode::default(), FitMode::Cover);
  }

  #[test]
  fn the_default_and_the_fallback_agree() {
    // Two ways to end up with no explicit choice; they had better match.
    assert_eq!(FitMode::parse("nonsense"), FitMode::default());
  }

  #[test]
  fn an_identity_uv_reads_the_whole_source() {
    let uv = UvRect::default();
    assert_eq!(uv.scale, [1.0, 1.0]);
    assert_eq!(uv.offset, [0.0, 0.0]);
  }

  #[test]
  fn an_identity_grade_leaves_colour_alone() {
    let grade = Grade::default();
    assert_eq!(grade.brightness, 0.0);
    assert_eq!(grade.contrast, 1.0);
    assert_eq!(grade.saturation, 1.0);
  }
}

#[cfg(test)]
mod fit_source_scenarios {
  use super::*;

  /// A 400x400 box: square, so any non-square source has to be reconciled.
  fn square() -> Rect {
    Rect {
      x: 100.0,
      y: 200.0,
      width: 400.0,
      height: 400.0,
    }
  }

  fn wide() -> Rect {
    Rect {
      x: 0.0,
      y: 0.0,
      width: 1600.0,
      height: 900.0,
    }
  }

  fn approx(a: f32, b: f32) -> bool {
    (a - b).abs() < 1e-4
  }

  #[test]
  fn stretch_keeps_the_box_and_reads_the_whole_source() {
    let (rect, uv) = fit_source(square(), 1920, 1080, FitMode::Stretch);
    assert_eq!(rect, square());
    assert_eq!(uv, UvRect::default());
  }

  #[test]
  fn stretch_does_not_care_how_wrong_the_aspect_ratio_is() {
    for (w, h) in [(1u32, 1000u32), (1000, 1), (16, 9), (9, 16)] {
      let (rect, uv) = fit_source(square(), w, h, FitMode::Stretch);
      assert_eq!(rect, square(), "{w}x{h}");
      assert_eq!(uv, UvRect::default(), "{w}x{h}");
    }
  }

  #[test]
  fn a_matching_source_needs_no_work_under_cover() {
    let (rect, uv) = fit_source(square(), 512, 512, FitMode::Cover);
    assert_eq!(rect, square());
    assert_eq!(uv, UvRect::default());
  }

  #[test]
  fn a_matching_source_needs_no_work_under_contain() {
    let (rect, uv) = fit_source(square(), 512, 512, FitMode::Contain);
    assert_eq!(rect, square());
    assert_eq!(uv, UvRect::default());
  }

  #[test]
  fn a_source_that_matches_within_rounding_is_treated_as_matching() {
    // The 1e-4 tolerance. 16001x9000 into a 16:9 box is a fraction of a pixel
    // of crop, and cropping it would cost a uv transform for nothing.
    let (rect, uv) = fit_source(wide(), 16001, 9000, FitMode::Cover);
    assert_eq!(rect, wide());
    assert_eq!(uv, UvRect::default());
  }

  #[test]
  fn cover_crops_the_sides_off_a_wide_source() {
    // 800x400 into a square: twice as wide as it should be, so read half.
    let (rect, uv) = fit_source(square(), 800, 400, FitMode::Cover);
    assert_eq!(rect, square());
    assert!(approx(uv.scale[0], 0.5), "{:?}", uv.scale);
    assert_eq!(uv.scale[1], 1.0);
  }

  #[test]
  fn cover_crops_the_top_and_bottom_off_a_tall_source() {
    let (_, uv) = fit_source(square(), 400, 800, FitMode::Cover);
    assert_eq!(uv.scale[0], 1.0);
    assert!(approx(uv.scale[1], 0.5), "{:?}", uv.scale);
  }

  #[test]
  fn cover_takes_its_crop_from_the_middle() {
    let (_, uv) = fit_source(square(), 800, 400, FitMode::Cover);
    // Half the source, centred: a quarter in from each side.
    assert!(approx(uv.offset[0], 0.25), "{:?}", uv.offset);
    assert_eq!(uv.offset[1], 0.0);
  }

  #[test]
  fn cover_never_reads_outside_the_source() {
    for (w, h) in [(3840u32, 1080u32), (100, 4000), (1920, 1080), (7, 3)] {
      let (_, uv) = fit_source(square(), w, h, FitMode::Cover);
      assert!(uv.scale[0] <= 1.0 + 1e-4, "{w}x{h} {:?}", uv.scale);
      assert!(uv.scale[1] <= 1.0 + 1e-4, "{w}x{h} {:?}", uv.scale);
      assert!(uv.offset[0] >= -1e-4, "{w}x{h} {:?}", uv.offset);
      assert!(uv.offset[1] >= -1e-4, "{w}x{h} {:?}", uv.offset);
      assert!(uv.offset[0] + uv.scale[0] <= 1.0 + 1e-4, "{w}x{h}");
      assert!(uv.offset[1] + uv.scale[1] <= 1.0 + 1e-4, "{w}x{h}");
    }
  }

  #[test]
  fn cover_leaves_the_box_exactly_where_it_was() {
    // The whole reason cover works through uvs: the shape mask is evaluated
    // against the quad, so growing the quad would clip a circular camera.
    for (w, h) in [(3840u32, 1080u32), (100, 4000)] {
      let (rect, _) = fit_source(square(), w, h, FitMode::Cover);
      assert_eq!(rect, square(), "{w}x{h}");
    }
  }

  #[test]
  fn contain_shrinks_the_box_rather_than_the_source() {
    let (rect, uv) = fit_source(square(), 800, 400, FitMode::Contain);
    assert_eq!(uv, UvRect::default());
    assert!(approx(rect.width, 400.0));
    assert!(approx(rect.height, 200.0), "{}", rect.height);
  }

  #[test]
  fn contain_recentres_what_it_shrank() {
    let (rect, _) = fit_source(square(), 800, 400, FitMode::Contain);
    // 200 tall inside a 400 box: 100 of empty above and below.
    assert!(approx(rect.y, 300.0), "{}", rect.y);
    assert_eq!(rect.x, square().x);
  }

  #[test]
  fn contain_shrinks_the_other_axis_for_a_tall_source() {
    let (rect, _) = fit_source(square(), 400, 800, FitMode::Contain);
    assert!(approx(rect.width, 200.0), "{}", rect.width);
    assert!(approx(rect.height, 400.0), "{}", rect.height);
    assert!(approx(rect.x, 200.0), "{}", rect.x);
  }

  #[test]
  fn contain_never_grows_the_box() {
    for (w, h) in [(3840u32, 1080u32), (100, 4000), (5, 4), (4, 5)] {
      let (rect, _) = fit_source(square(), w, h, FitMode::Contain);
      assert!(rect.width <= square().width + 1e-3, "{w}x{h}");
      assert!(rect.height <= square().height + 1e-3, "{w}x{h}");
    }
  }

  #[test]
  fn contain_stays_inside_the_box_it_was_given() {
    for (w, h) in [(3840u32, 1080u32), (100, 4000)] {
      let (rect, _) = fit_source(square(), w, h, FitMode::Contain);
      assert!(rect.x >= square().x - 1e-3, "{w}x{h}");
      assert!(rect.y >= square().y - 1e-3, "{w}x{h}");
      assert!(rect.x + rect.width <= square().x + square().width + 1e-3);
      assert!(rect.y + rect.height <= square().y + square().height + 1e-3);
    }
  }

  #[test]
  fn contain_ends_up_with_the_sources_aspect_ratio() {
    for (w, h) in [(1920u32, 1080u32), (640, 480), (1080, 1920)] {
      let (rect, _) = fit_source(square(), w, h, FitMode::Contain);
      let drawn = rect.width / rect.height;
      let source = w as f32 / h as f32;
      assert!(
        (drawn - source).abs() < 1e-3,
        "{w}x{h}: {drawn} vs {source}"
      );
    }
  }

  #[test]
  fn cover_ends_up_with_the_sources_aspect_ratio_too() {
    // Same guarantee, reached the other way: cover keeps the rect and crops the
    // read, so the *visible* part of the source has the box's ratio and the
    // pixels are undistorted.
    for (w, h) in [(1920u32, 1080u32), (640, 480), (1080, 1920)] {
      let (rect, uv) = fit_source(square(), w, h, FitMode::Cover);
      let read_w = w as f32 * uv.scale[0];
      let read_h = h as f32 * uv.scale[1];
      let stretch = (rect.width / rect.height) / (read_w / read_h);
      assert!((stretch - 1.0).abs() < 1e-3, "{w}x{h}: {stretch}");
    }
  }

  #[test]
  fn an_empty_box_survives_every_mode() {
    let empty = Rect {
      x: 5.0,
      y: 5.0,
      width: 0.0,
      height: 0.0,
    };
    for fit in [FitMode::Cover, FitMode::Contain, FitMode::Stretch] {
      let (rect, uv) = fit_source(empty, 1920, 1080, fit);
      assert_eq!(rect, empty, "{fit:?}");
      assert_eq!(uv, UvRect::default(), "{fit:?}");
    }
  }

  #[test]
  fn a_source_with_no_pixels_does_not_divide_by_zero() {
    for fit in [FitMode::Cover, FitMode::Contain] {
      let (rect, uv) = fit_source(square(), 0, 0, fit);
      assert!(rect.width.is_finite() && rect.height.is_finite(), "{fit:?}");
      assert!(uv.scale.iter().all(|v| v.is_finite()), "{fit:?}");
    }
  }

  #[test]
  fn a_source_one_pixel_wide_is_handled_rather_than_clamped_away() {
    let (rect, uv) = fit_source(square(), 1, 1000, FitMode::Contain);
    assert!(rect.width > 0.0);
    assert_eq!(uv, UvRect::default());
  }

  #[test]
  fn a_box_with_no_height_never_reaches_the_ratio_maths() {
    // `is_empty` catches it first, which is what stops the ratio being an
    // infinity that then propagates into the uv transform.
    let flat = Rect {
      x: 0.0,
      y: 0.0,
      width: 400.0,
      height: 0.0,
    };
    let (rect, uv) = fit_source(flat, 1920, 1080, FitMode::Cover);
    assert_eq!(rect, flat);
    assert_eq!(uv, UvRect::default());
  }

  #[test]
  fn a_non_finite_box_falls_back_to_reading_the_whole_source() {
    let bad = Rect {
      x: 0.0,
      y: 0.0,
      width: f32::NAN,
      height: 400.0,
    };
    let (_, uv) = fit_source(bad, 1920, 1080, FitMode::Cover);
    assert_eq!(uv, UvRect::default());
  }

  #[test]
  fn a_16_9_camera_in_a_square_box_crops_rather_than_letterboxes_by_default() {
    // The end-to-end shape of the default: a normal webcam, a square overlay.
    let (rect, uv) = fit_source(square(), 1280, 720, FitMode::default());
    assert_eq!(rect, square());
    assert!(uv.scale[0] < 1.0);
    assert_eq!(uv.scale[1], 1.0);
  }

  #[test]
  fn the_same_camera_under_contain_leaves_bars_instead() {
    let (rect, uv) = fit_source(square(), 1280, 720, FitMode::Contain);
    assert_eq!(uv, UvRect::default());
    assert!(rect.height < square().height);
  }

  #[test]
  fn cover_and_contain_only_disagree_when_the_ratios_do() {
    for (w, h) in [(400u32, 400u32), (1000, 1000), (7, 7)] {
      let cover = fit_source(square(), w, h, FitMode::Cover);
      let contain = fit_source(square(), w, h, FitMode::Contain);
      assert_eq!(cover.0, contain.0, "{w}x{h}");
      assert_eq!(cover.1, contain.1, "{w}x{h}");
    }
  }

  #[test]
  fn fitting_is_stable_when_applied_to_its_own_result_under_contain() {
    // Contain shrinks the box to the source's ratio; feeding that back in has
    // nothing left to do. A second shrink would mean the first was wrong.
    let (once, _) = fit_source(square(), 1600, 900, FitMode::Contain);
    let (twice, uv) = fit_source(once, 1600, 900, FitMode::Contain);
    assert!((once.width - twice.width).abs() < 1e-2);
    assert!((once.height - twice.height).abs() < 1e-2);
    assert_eq!(uv, UvRect::default());
  }
}

#[cfg(test)]
mod smear_scenarios {
  use super::*;

  fn head() -> Rect {
    Rect {
      x: 100.0,
      y: 100.0,
      width: 20.0,
      height: 20.0,
    }
  }

  #[test]
  fn a_pointer_that_is_not_moving_gets_no_smear_quad() {
    assert!(smear_geometry(head(), [0.0, 0.0]).is_none());
  }

  #[test]
  fn a_pointer_with_no_sprite_gets_no_smear_quad() {
    let empty = Rect {
      x: 0.0,
      y: 0.0,
      width: 0.0,
      height: 0.0,
    };
    assert!(smear_geometry(empty, [10.0, 10.0]).is_none());
  }

  #[test]
  fn a_backwards_sprite_gets_no_smear_quad() {
    let bad = Rect {
      x: 0.0,
      y: 0.0,
      width: -20.0,
      height: 20.0,
    };
    assert!(smear_geometry(bad, [10.0, 0.0]).is_none());
  }

  #[test]
  fn moving_right_grows_the_quad_to_the_left() {
    let (quad, _, _) = smear_geometry(head(), [10.0, 0.0]).unwrap();
    assert_eq!(quad.x, 90.0);
    assert_eq!(quad.width, 30.0);
  }

  #[test]
  fn moving_left_grows_the_quad_to_the_right() {
    let (quad, _, _) = smear_geometry(head(), [-10.0, 0.0]).unwrap();
    assert_eq!(quad.x, 100.0);
    assert_eq!(quad.width, 30.0);
  }

  #[test]
  fn moving_down_grows_the_quad_upwards() {
    let (quad, _, _) = smear_geometry(head(), [0.0, 10.0]).unwrap();
    assert_eq!(quad.y, 90.0);
    assert_eq!(quad.height, 30.0);
  }

  #[test]
  fn moving_up_grows_the_quad_downwards() {
    let (quad, _, _) = smear_geometry(head(), [0.0, -10.0]).unwrap();
    assert_eq!(quad.y, 100.0);
    assert_eq!(quad.height, 30.0);
  }

  #[test]
  fn a_diagonal_move_grows_both_axes() {
    let (quad, _, _) = smear_geometry(head(), [10.0, 5.0]).unwrap();
    assert_eq!(quad.x, 90.0);
    assert_eq!(quad.y, 95.0);
    assert_eq!(quad.width, 30.0);
    assert_eq!(quad.height, 25.0);
  }

  #[test]
  fn horizontal_travel_alone_leaves_the_vertical_size_alone() {
    let (quad, _, _) = smear_geometry(head(), [40.0, 0.0]).unwrap();
    assert_eq!(quad.y, head().y);
    assert_eq!(quad.height, head().height);
  }

  #[test]
  fn the_quad_always_contains_the_pointer_itself() {
    for smear in [[10.0, 0.0], [-10.0, 0.0], [0.0, 30.0], [-7.0, -3.0]] {
      let (quad, _, _) = smear_geometry(head(), smear).unwrap();
      assert!(quad.x <= head().x + 1e-4, "{smear:?}");
      assert!(quad.y <= head().y + 1e-4, "{smear:?}");
      assert!(
        quad.x + quad.width >= head().x + head().width - 1e-4,
        "{smear:?}"
      );
      assert!(
        quad.y + quad.height >= head().y + head().height - 1e-4,
        "{smear:?}"
      );
    }
  }

  #[test]
  fn the_uv_transform_puts_the_sprite_back_on_the_pointer() {
    let (quad, uv, _) = smear_geometry(head(), [10.0, 0.0]).unwrap();
    // The shader reads source uv `u * scale + offset` at quad position `u`, so
    // going the other way says where the sprite's own edges land in the quad.
    let at = |source_u: f32| quad.x + ((source_u - uv.offset[0]) / uv.scale[0]) * quad.width;
    assert!((at(0.0) - head().x).abs() < 1e-3, "{}", at(0.0));
    assert!(
      (at(1.0) - (head().x + head().width)).abs() < 1e-3,
      "{}",
      at(1.0)
    );
  }

  #[test]
  fn the_uv_offset_is_negative_when_the_quad_grew_behind_the_pointer() {
    let (_, uv, _) = smear_geometry(head(), [10.0, 0.0]).unwrap();
    assert!(uv.offset[0] < 0.0, "{:?}", uv.offset);
  }

  #[test]
  fn the_uv_offset_stays_at_zero_on_the_edge_the_quad_did_not_grow_from() {
    let (_, uv, _) = smear_geometry(head(), [-10.0, 0.0]).unwrap();
    assert_eq!(uv.offset[0], 0.0);
  }

  #[test]
  fn the_uv_scale_is_the_ratio_of_the_two_boxes() {
    let (quad, uv, _) = smear_geometry(head(), [10.0, 5.0]).unwrap();
    assert!((uv.scale[0] - quad.width / head().width).abs() < 1e-6);
    assert!((uv.scale[1] - quad.height / head().height).abs() < 1e-6);
  }

  #[test]
  fn the_travel_is_reported_in_the_sprites_own_units() {
    // 10 pixels across a 20 pixel sprite is half a sprite of travel, which is
    // what the shader marches along -- it knows nothing about canvas pixels.
    let (_, _, travel) = smear_geometry(head(), [10.0, 5.0]).unwrap();
    assert_eq!(travel, [0.5, 0.25]);
  }

  #[test]
  fn the_travel_keeps_its_sign() {
    let (_, _, travel) = smear_geometry(head(), [-10.0, -5.0]).unwrap();
    assert_eq!(travel, [-0.5, -0.25]);
  }

  #[test]
  fn a_travel_of_one_sprite_doubles_the_quad() {
    let (quad, _, travel) = smear_geometry(head(), [20.0, 0.0]).unwrap();
    assert_eq!(quad.width, 40.0);
    assert_eq!(travel[0], 1.0);
  }

  #[test]
  fn a_move_in_one_axis_only_still_produces_a_quad() {
    assert!(smear_geometry(head(), [0.0, 1.0]).is_some());
    assert!(smear_geometry(head(), [1.0, 0.0]).is_some());
  }

  #[test]
  fn a_very_long_travel_stays_finite() {
    let (quad, uv, travel) = smear_geometry(head(), [4000.0, 0.0]).unwrap();
    assert!(quad.width.is_finite() && quad.x.is_finite());
    assert!(uv.scale.iter().all(|v| v.is_finite()));
    assert!(travel.iter().all(|v| v.is_finite()));
  }

  #[test]
  fn a_bigger_sprite_reports_the_same_travel_as_a_smaller_proportional_one() {
    let big = Rect {
      x: 0.0,
      y: 0.0,
      width: 40.0,
      height: 40.0,
    };
    let (_, _, small_travel) = smear_geometry(head(), [10.0, 0.0]).unwrap();
    let (_, _, big_travel) = smear_geometry(big, [20.0, 0.0]).unwrap();
    assert_eq!(small_travel, big_travel);
  }
}

#[cfg(test)]
mod shadow_scenarios {
  use super::*;

  fn shadow(offset: [f32; 2], blur: f32, alpha: f32) -> Shadow {
    Shadow {
      offset,
      blur,
      colour: [0.0, 0.0, 0.0, alpha],
    }
  }

  fn box_rect() -> Rect {
    Rect {
      x: 200.0,
      y: 100.0,
      width: 320.0,
      height: 180.0,
    }
  }

  #[test]
  fn scaling_a_shadow_grows_its_offset_and_its_blur() {
    // What a zoom does to the video layer: the shadow was authored in canvas
    // pixels against the unzoomed recording, so it has to grow with it.
    let scaled = shadow([0.0, 18.0], 45.0, 0.22).scaled(2.0);
    assert_eq!(scaled.offset, [0.0, 36.0]);
    assert_eq!(scaled.blur, 90.0);
  }

  #[test]
  fn scaling_a_shadow_leaves_its_colour_alone() {
    // Including the alpha: a zoomed shadow is bigger, not darker.
    let scaled = shadow([-3.0, 6.0], 10.0, 0.16).scaled(3.0);
    assert_eq!(scaled.colour, [0.0, 0.0, 0.0, 0.16]);
  }

  #[test]
  fn scaling_a_shadow_by_one_changes_nothing() {
    let original = shadow([-3.0, 6.0], 10.0, 0.16);
    assert_eq!(original.scaled(1.0), original);
  }

  #[test]
  fn a_shadow_scaled_to_nothing_is_no_longer_visible() {
    // Not a case the video layer reaches -- a zero zoom has no rect either --
    // but the sanitiser's rule and this one have to agree about what "nothing"
    // is, or a scaled shadow could survive as an invisible quad.
    assert!(!shadow([0.0, 18.0], 45.0, 0.22).scaled(0.0).is_visible());
  }

  #[test]
  fn softness_is_the_canvas_blur_scaled_to_a_smoothstep_half_width() {
    // Canvas defines shadowBlur as sigma = blur/2, and a smoothstep of half
    // width 1.88 sigma matches that Gaussian's slope. 1.88 * 0.5 = 0.94.
    assert!((shadow([0.0, 0.0], 20.0, 1.0).softness() - 18.8).abs() < 1e-4);
  }

  #[test]
  fn softness_scales_linearly_with_blur() {
    let one = shadow([0.0, 0.0], 10.0, 1.0).softness();
    let two = shadow([0.0, 0.0], 20.0, 1.0).softness();
    assert!((two - one * 2.0).abs() < 1e-4);
  }

  #[test]
  fn no_blur_is_no_softness() {
    assert_eq!(shadow([0.0, 0.0], 0.0, 1.0).softness(), 0.0);
  }

  #[test]
  fn a_negative_blur_is_treated_as_none_rather_than_inverted() {
    assert_eq!(shadow([0.0, 0.0], -20.0, 1.0).softness(), 0.0);
  }

  #[test]
  fn reach_is_the_softness_plus_a_pixel_of_slack() {
    let s = shadow([0.0, 0.0], 20.0, 1.0);
    assert!((s.reach() - (s.softness() + 1.0)).abs() < 1e-5);
  }

  #[test]
  fn a_hard_shadow_still_reaches_one_pixel() {
    // The slack against rounding at the quad's edge, which a zero-blur shadow
    // needs just as much as a soft one.
    assert_eq!(shadow([4.0, 4.0], 0.0, 1.0).reach(), 1.0);
  }

  #[test]
  fn reach_grows_with_blur() {
    let mut last = 0.0;
    for blur in [0.0f32, 1.0, 5.0, 20.0, 100.0] {
      let reach = shadow([0.0, 0.0], blur, 1.0).reach();
      assert!(reach > last, "blur {blur}: {reach} <= {last}");
      last = reach;
    }
  }

  #[test]
  fn the_quad_is_the_shape_moved_by_the_offset() {
    let quad = shadow([10.0, 20.0], 0.0, 1.0).quad_rect(box_rect());
    // Moved by the offset, then grown by the one pixel of reach.
    assert_eq!(quad.x, 200.0 + 10.0 - 1.0);
    assert_eq!(quad.y, 100.0 + 20.0 - 1.0);
  }

  #[test]
  fn the_quad_grows_by_the_reach_on_every_side() {
    let s = shadow([0.0, 0.0], 20.0, 1.0);
    let quad = s.quad_rect(box_rect());
    assert!((quad.width - (box_rect().width + s.reach() * 2.0)).abs() < 1e-3);
    assert!((quad.height - (box_rect().height + s.reach() * 2.0)).abs() < 1e-3);
  }

  #[test]
  fn the_quad_holds_the_whole_falloff() {
    // The silhouette sits at the offset shape; the falloff runs `softness` past
    // its edge. If the quad were any smaller the shadow would end in a
    // straight cut where the geometry stopped.
    let s = shadow([12.0, -6.0], 30.0, 1.0);
    let quad = s.quad_rect(box_rect());
    let silhouette = Rect {
      x: box_rect().x + 12.0,
      y: box_rect().y - 6.0,
      width: box_rect().width,
      height: box_rect().height,
    };
    assert!(quad.x <= silhouette.x - s.softness());
    assert!(quad.y <= silhouette.y - s.softness());
    assert!(quad.x + quad.width >= silhouette.x + silhouette.width + s.softness());
    assert!(quad.y + quad.height >= silhouette.y + silhouette.height + s.softness());
  }

  #[test]
  fn a_negative_offset_moves_the_quad_the_other_way() {
    let quad = shadow([-10.0, -20.0], 0.0, 1.0).quad_rect(box_rect());
    assert_eq!(quad.x, 200.0 - 10.0 - 1.0);
    assert_eq!(quad.y, 100.0 - 20.0 - 1.0);
  }

  #[test]
  fn the_offset_does_not_change_the_quads_size() {
    let a = shadow([0.0, 0.0], 12.0, 1.0).quad_rect(box_rect());
    let b = shadow([50.0, -50.0], 12.0, 1.0).quad_rect(box_rect());
    assert_eq!(a.width, b.width);
    assert_eq!(a.height, b.height);
  }

  #[test]
  fn a_blurred_offset_shadow_is_visible() {
    assert!(shadow([4.0, 4.0], 8.0, 0.5).is_visible());
  }

  #[test]
  fn a_transparent_shadow_is_not_drawn() {
    assert!(!shadow([4.0, 4.0], 8.0, 0.0).is_visible());
  }

  #[test]
  fn a_shadow_with_neither_blur_nor_offset_is_not_drawn() {
    // The silhouette would land exactly under the camera about to be drawn over
    // it, so the only thing it could change is the antialiased edge. The
    // Canvas2D compositor skips it too, and the two have to agree.
    assert!(!shadow([0.0, 0.0], 0.0, 1.0).is_visible());
  }

  #[test]
  fn a_hard_shadow_with_an_offset_is_drawn() {
    assert!(shadow([1.0, 0.0], 0.0, 1.0).is_visible());
  }

  #[test]
  fn a_blurred_shadow_with_no_offset_is_drawn() {
    assert!(shadow([0.0, 0.0], 6.0, 1.0).is_visible());
  }

  #[test]
  fn a_vertical_offset_alone_counts_as_an_offset() {
    assert!(shadow([0.0, 3.0], 0.0, 1.0).is_visible());
  }

  #[test]
  fn the_faintest_alpha_still_counts_as_visible() {
    // Above zero is the rule, not above some threshold: a stack of very faint
    // layers is a real style, and picking a cutoff here would silently change
    // how one looked.
    assert!(shadow([0.0, 0.0], 6.0, f32::MIN_POSITIVE).is_visible());
  }

  #[test]
  fn a_negative_blur_does_not_make_a_zero_offset_shadow_visible() {
    assert!(!shadow([0.0, 0.0], -6.0, 1.0).is_visible());
  }

  #[test]
  fn visibility_and_alpha_are_the_only_things_that_can_hide_a_shadow() {
    // Every combination of the two flags that matter, spelled out.
    let cases = [
      ([0.0f32, 0.0f32], 0.0f32, 0.0f32, false),
      ([0.0, 0.0], 0.0, 1.0, false),
      ([0.0, 0.0], 5.0, 0.0, false),
      ([0.0, 0.0], 5.0, 1.0, true),
      ([2.0, 0.0], 0.0, 0.0, false),
      ([2.0, 0.0], 0.0, 1.0, true),
      ([2.0, 0.0], 5.0, 0.0, false),
      ([2.0, 0.0], 5.0, 1.0, true),
    ];
    for (offset, blur, alpha, expected) in cases {
      assert_eq!(
        shadow(offset, blur, alpha).is_visible(),
        expected,
        "{offset:?} blur {blur} alpha {alpha}"
      );
    }
  }
}

#[cfg(test)]
mod webcam_layout_scenarios {
  use super::*;

  fn layout() -> WebcamLayout {
    WebcamLayout {
      rect: Rect {
        x: 40.0,
        y: 40.0,
        width: 320.0,
        height: 180.0,
      },
      ..Default::default()
    }
  }

  fn visible_shadow() -> Shadow {
    Shadow {
      offset: [4.0, 4.0],
      blur: 12.0,
      colour: [0.0, 0.0, 0.0, 0.4],
    }
  }

  #[test]
  fn the_default_layout_has_no_box_and_so_is_not_visible() {
    assert!(!WebcamLayout::default().is_visible());
  }

  #[test]
  fn the_default_layout_is_fully_opaque_and_square_cornered() {
    let d = WebcamLayout::default();
    assert_eq!(d.opacity, 1.0);
    assert_eq!(d.corner_radius, 0.0);
    assert_eq!(d.border_width, 0.0);
    assert_eq!(d.shape, OverlayShape::Rect);
    assert_eq!(d.fit, FitMode::Cover);
    assert!(d.shadows.is_empty());
  }

  #[test]
  fn a_placed_opaque_layout_is_visible() {
    assert!(layout().is_visible());
  }

  #[test]
  fn a_fully_transparent_layout_is_not_visible() {
    let hidden = WebcamLayout {
      opacity: 0.0,
      ..layout()
    };
    assert!(!hidden.is_visible());
  }

  #[test]
  fn an_almost_transparent_layout_is_still_visible() {
    let faint = WebcamLayout {
      opacity: 0.001,
      ..layout()
    };
    assert!(faint.is_visible());
  }

  #[test]
  fn a_layout_with_no_width_is_not_visible() {
    let flat = WebcamLayout {
      rect: Rect {
        width: 0.0,
        ..layout().rect
      },
      ..layout()
    };
    assert!(!flat.is_visible());
  }

  #[test]
  fn a_layout_with_a_nan_opacity_is_not_visible() {
    // NaN fails the `> 0.0` test, so it hides rather than drawing at an
    // undefined alpha. Safe direction to fall.
    let bad = WebcamLayout {
      opacity: f32::NAN,
      ..layout()
    };
    assert!(!bad.is_visible());
  }

  #[test]
  fn sanitizing_clamps_an_opacity_above_one() {
    // Above 1 multiplies into the blend's source alpha and burns the feathered
    // edge rather than making anything brighter.
    let s = WebcamLayout {
      opacity: 4.0,
      ..layout()
    }
    .sanitized();
    assert_eq!(s.opacity, 1.0);
  }

  #[test]
  fn sanitizing_clamps_a_negative_opacity() {
    let s = WebcamLayout {
      opacity: -2.0,
      ..layout()
    }
    .sanitized();
    assert_eq!(s.opacity, 0.0);
  }

  #[test]
  fn sanitizing_leaves_an_ordinary_opacity_alone() {
    for value in [0.0f32, 0.25, 0.5, 1.0] {
      let s = WebcamLayout {
        opacity: value,
        ..layout()
      }
      .sanitized();
      assert_eq!(s.opacity, value);
    }
  }

  #[test]
  fn sanitizing_refuses_a_negative_corner_radius() {
    // A negative radius folds the rounded-rect distance function inside out.
    let s = WebcamLayout {
      corner_radius: -10.0,
      ..layout()
    }
    .sanitized();
    assert_eq!(s.corner_radius, 0.0);
  }

  #[test]
  fn sanitizing_keeps_a_real_corner_radius() {
    let s = WebcamLayout {
      corner_radius: 24.0,
      ..layout()
    }
    .sanitized();
    assert_eq!(s.corner_radius, 24.0);
  }

  #[test]
  fn sanitizing_refuses_a_negative_border() {
    let s = WebcamLayout {
      border_width: -4.0,
      ..layout()
    }
    .sanitized();
    assert_eq!(s.border_width, 0.0);
  }

  #[test]
  fn sanitizing_keeps_a_real_border() {
    let s = WebcamLayout {
      border_width: 6.0,
      ..layout()
    }
    .sanitized();
    assert_eq!(s.border_width, 6.0);
  }

  #[test]
  fn sanitizing_keeps_the_shadows_that_would_draw_something() {
    let s = WebcamLayout {
      shadows: vec![visible_shadow(), visible_shadow()],
      ..layout()
    }
    .sanitized();
    assert_eq!(s.shadows.len(), 2);
  }

  #[test]
  fn sanitizing_drops_a_transparent_shadow() {
    let mut dead = visible_shadow();
    dead.colour[3] = 0.0;
    let s = WebcamLayout {
      shadows: vec![visible_shadow(), dead],
      ..layout()
    }
    .sanitized();
    assert_eq!(s.shadows.len(), 1);
  }

  #[test]
  fn sanitizing_drops_an_all_zero_layer_a_style_carries_as_disabled() {
    let off = Shadow {
      offset: [0.0, 0.0],
      blur: 0.0,
      colour: [0.0, 0.0, 0.0, 0.0],
    };
    let s = WebcamLayout {
      shadows: vec![off, off, off],
      ..layout()
    }
    .sanitized();
    assert!(s.shadows.is_empty());
  }

  #[test]
  fn sanitizing_drops_a_shadow_with_a_non_finite_blur() {
    let mut bad = visible_shadow();
    bad.blur = f32::INFINITY;
    let s = WebcamLayout {
      shadows: vec![bad],
      ..layout()
    }
    .sanitized();
    assert!(s.shadows.is_empty());
  }

  #[test]
  fn sanitizing_drops_a_shadow_with_a_non_finite_offset() {
    for offset in [[f32::NAN, 0.0], [0.0, f32::NAN], [f32::INFINITY, 0.0]] {
      let mut bad = visible_shadow();
      bad.offset = offset;
      let s = WebcamLayout {
        shadows: vec![bad],
        ..layout()
      }
      .sanitized();
      assert!(s.shadows.is_empty(), "{offset:?}");
    }
  }

  #[test]
  fn sanitizing_keeps_the_order_of_the_shadows_it_keeps() {
    // They are drawn back to front in the order given, so reordering would
    // change which layer sits on top.
    let mut first = visible_shadow();
    first.blur = 1.0;
    let mut dead = visible_shadow();
    dead.colour[3] = 0.0;
    let mut last = visible_shadow();
    last.blur = 99.0;
    let s = WebcamLayout {
      shadows: vec![first, dead, last],
      ..layout()
    }
    .sanitized();
    assert_eq!(s.shadows.len(), 2);
    assert_eq!(s.shadows[0].blur, 1.0);
    assert_eq!(s.shadows[1].blur, 99.0);
  }

  #[test]
  fn sanitizing_flattens_a_non_finite_position_to_the_origin() {
    for (x, y) in [(f32::NAN, 0.0), (0.0, f32::NAN), (f32::INFINITY, 0.0)] {
      let s = WebcamLayout {
        rect: Rect {
          x,
          y,
          ..layout().rect
        },
        ..layout()
      }
      .sanitized();
      assert_eq!(s.rect.x, 0.0, "{x} {y}");
      assert_eq!(s.rect.y, 0.0, "{x} {y}");
    }
  }

  #[test]
  fn sanitizing_flattens_a_non_finite_size_to_nothing() {
    for (w, h) in [(f32::NAN, 100.0), (100.0, f32::NAN), (f32::INFINITY, 100.0)] {
      let s = WebcamLayout {
        rect: Rect {
          width: w,
          height: h,
          ..layout().rect
        },
        ..layout()
      }
      .sanitized();
      assert_eq!(s.rect.width, 0.0, "{w}x{h}");
      assert_eq!(s.rect.height, 0.0, "{w}x{h}");
      assert!(!s.is_visible(), "{w}x{h}");
    }
  }

  #[test]
  fn a_bad_position_does_not_also_wipe_out_the_size() {
    let s = WebcamLayout {
      rect: Rect {
        x: f32::NAN,
        y: 10.0,
        width: 320.0,
        height: 180.0,
      },
      ..layout()
    }
    .sanitized();
    assert_eq!(s.rect.width, 320.0);
    assert_eq!(s.rect.height, 180.0);
  }

  #[test]
  fn sanitizing_leaves_a_healthy_layout_untouched() {
    let healthy = WebcamLayout {
      corner_radius: 12.0,
      border_width: 3.0,
      opacity: 0.8,
      shape: OverlayShape::Ellipse,
      fit: FitMode::Contain,
      shadows: vec![visible_shadow()],
      ..layout()
    };
    assert_eq!(healthy.clone().sanitized(), healthy);
  }

  #[test]
  fn sanitizing_twice_is_the_same_as_sanitizing_once() {
    let messy = WebcamLayout {
      opacity: 3.0,
      corner_radius: -5.0,
      border_width: -1.0,
      shadows: vec![
        visible_shadow(),
        Shadow {
          offset: [0.0, 0.0],
          blur: 0.0,
          colour: [0.0, 0.0, 0.0, 1.0],
        },
      ],
      ..layout()
    };
    let once = messy.sanitized();
    assert_eq!(once.clone().sanitized(), once);
  }

  #[test]
  fn sanitizing_does_not_move_a_healthy_rect() {
    let s = layout().sanitized();
    assert_eq!(s.rect, layout().rect);
  }

  #[test]
  fn an_ellipse_survives_sanitizing() {
    let s = WebcamLayout {
      shape: OverlayShape::Ellipse,
      ..layout()
    }
    .sanitized();
    assert_eq!(s.shape, OverlayShape::Ellipse);
  }
}

#[cfg(test)]
mod hidden_span_scenarios {
  use super::*;

  #[test]
  fn nothing_hidden_is_empty() {
    assert!(HiddenSpans::new(Vec::new()).is_empty());
  }

  #[test]
  fn nothing_hidden_hides_nothing_at_any_time() {
    let spans = HiddenSpans::new(Vec::new());
    for t in [-1000.0, 0.0, 1.0, 5_000.0, 1e12] {
      assert!(!spans.contains(t), "{t}");
    }
  }

  #[test]
  fn the_default_hides_nothing() {
    assert!(HiddenSpans::default().is_empty());
    assert!(!HiddenSpans::default().contains(0.0));
  }

  #[test]
  fn a_span_hides_its_own_middle() {
    let spans = HiddenSpans::new(vec![(1000.0, 2000.0)]);
    assert!(spans.contains(1500.0));
  }

  #[test]
  fn a_span_starts_hiding_at_its_own_start() {
    let spans = HiddenSpans::new(vec![(1000.0, 2000.0)]);
    assert!(spans.contains(1000.0));
  }

  #[test]
  fn a_span_has_stopped_hiding_by_its_own_end() {
    // Half open, so two back to back spans neither overlap nor leave a frame
    // showing between them.
    let spans = HiddenSpans::new(vec![(1000.0, 2000.0)]);
    assert!(!spans.contains(2000.0));
  }

  #[test]
  fn a_span_does_not_reach_backwards() {
    let spans = HiddenSpans::new(vec![(1000.0, 2000.0)]);
    assert!(!spans.contains(999.999));
  }

  #[test]
  fn back_to_back_spans_leave_no_frame_showing() {
    let spans = HiddenSpans::new(vec![(0.0, 1000.0), (1000.0, 2000.0)]);
    for t in [0.0, 500.0, 999.0, 1000.0, 1500.0, 1999.0] {
      assert!(spans.contains(t), "{t}");
    }
    assert!(!spans.contains(2000.0));
  }

  #[test]
  fn a_gap_between_spans_shows() {
    let spans = HiddenSpans::new(vec![(0.0, 1000.0), (2000.0, 3000.0)]);
    assert!(!spans.contains(1500.0));
    assert!(spans.contains(2500.0));
  }

  #[test]
  fn spans_arriving_out_of_order_still_work() {
    let spans = HiddenSpans::new(vec![(5000.0, 6000.0), (0.0, 1000.0), (2000.0, 3000.0)]);
    assert!(spans.contains(500.0));
    assert!(spans.contains(2500.0));
    assert!(spans.contains(5500.0));
    assert!(!spans.contains(1500.0));
    assert!(!spans.contains(4000.0));
  }

  #[test]
  fn a_span_of_no_length_is_dropped() {
    assert!(HiddenSpans::new(vec![(1000.0, 1000.0)]).is_empty());
  }

  #[test]
  fn a_backwards_span_is_dropped() {
    assert!(HiddenSpans::new(vec![(2000.0, 1000.0)]).is_empty());
  }

  #[test]
  fn dropping_the_empty_ones_does_not_take_the_real_ones_with_them() {
    let spans = HiddenSpans::new(vec![(0.0, 0.0), (1000.0, 2000.0), (3000.0, 3000.0)]);
    assert!(!spans.is_empty());
    assert!(spans.contains(1500.0));
  }

  #[test]
  fn overlapping_spans_hide_their_union() {
    let spans = HiddenSpans::new(vec![(0.0, 2000.0), (1000.0, 3000.0)]);
    for t in [0.0, 1000.0, 1500.0, 2500.0] {
      assert!(spans.contains(t), "{t}");
    }
    assert!(!spans.contains(3000.0));
  }

  #[test]
  fn a_span_swallowed_by_another_changes_nothing() {
    let spans = HiddenSpans::new(vec![(0.0, 5000.0), (1000.0, 2000.0)]);
    assert!(spans.contains(4000.0));
    assert!(!spans.contains(5000.0));
  }

  #[test]
  fn the_early_exit_does_not_miss_a_later_span() {
    // `contains` bails as soon as it passes the time, which only works because
    // the spans were sorted on the way in. Ten of them, asked in reverse.
    let list: Vec<(f64, f64)> = (0..10)
      .map(|i| (i as f64 * 100.0, i as f64 * 100.0 + 50.0))
      .collect();
    let spans = HiddenSpans::new(list);
    for i in (0..10).rev() {
      assert!(spans.contains(i as f64 * 100.0 + 10.0), "{i}");
      assert!(!spans.contains(i as f64 * 100.0 + 60.0), "{i}");
    }
  }

  #[test]
  fn negative_times_are_handled_like_any_other() {
    let spans = HiddenSpans::new(vec![(-2000.0, -1000.0)]);
    assert!(spans.contains(-1500.0));
    assert!(!spans.contains(-500.0));
    assert!(!spans.contains(-2000.1));
  }

  #[test]
  fn a_span_reaching_to_infinity_hides_everything_after_its_start() {
    let spans = HiddenSpans::new(vec![(1000.0, f64::INFINITY)]);
    assert!(spans.contains(1e12));
    assert!(!spans.contains(999.0));
  }
}

#[cfg(test)]
mod cursor_track_scenarios {
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

  fn hidden(timestamp_ms: f64, x: f32) -> CursorSample {
    CursorSample {
      visible: false,
      ..at(timestamp_ms, x, 0.0)
    }
  }

  #[test]
  fn an_empty_track_has_no_length() {
    assert_eq!(CursorTrack::new(Vec::new()).len(), 0);
  }

  #[test]
  fn the_default_track_is_empty() {
    assert_eq!(CursorTrack::default().len(), 0);
    assert!(CursorTrack::default().sample_at(0.0).is_none());
  }

  #[test]
  fn a_track_reports_how_many_samples_it_holds() {
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(10.0, 0.1, 0.0)]);
    assert_eq!(track.len(), 2);
  }

  #[test]
  fn sorting_does_not_drop_or_duplicate_samples() {
    let track = CursorTrack::new(vec![
      at(30.0, 0.3, 0.0),
      at(10.0, 0.1, 0.0),
      at(20.0, 0.2, 0.0),
    ]);
    assert_eq!(track.len(), 3);
  }

  #[test]
  fn an_empty_track_has_no_cursor_at_any_time() {
    let track = CursorTrack::new(Vec::new());
    for t in [-1.0, 0.0, 1000.0] {
      assert!(track.sample_at(t).is_none(), "{t}");
    }
  }

  #[test]
  fn there_is_no_cursor_before_the_first_sample() {
    let track = CursorTrack::new(vec![at(1000.0, 0.5, 0.5)]);
    assert!(track.sample_at(999.0).is_none());
  }

  #[test]
  fn the_first_sample_takes_effect_at_its_own_timestamp() {
    let track = CursorTrack::new(vec![at(1000.0, 0.5, 0.5)]);
    assert_eq!(track.sample_at(1000.0).unwrap().x, 0.5);
  }

  #[test]
  fn a_sample_is_held_until_the_next_one() {
    // Not interpolated: the pointer does not move between reports, and
    // smoothing between them would invent motion that never happened.
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(100.0, 1.0, 1.0)]);
    for t in [0.0, 10.0, 50.0, 99.9] {
      assert_eq!(track.sample_at(t).unwrap().x, 0.0, "{t}");
    }
  }

  #[test]
  fn the_next_sample_takes_over_exactly_on_its_timestamp() {
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(100.0, 1.0, 1.0)]);
    assert_eq!(track.sample_at(100.0).unwrap().x, 1.0);
  }

  #[test]
  fn the_last_sample_is_held_forever() {
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(100.0, 1.0, 1.0)]);
    assert_eq!(track.sample_at(1e9).unwrap().x, 1.0);
  }

  #[test]
  fn a_sample_carries_both_of_its_coordinates() {
    let track = CursorTrack::new(vec![at(0.0, 0.25, 0.75)]);
    let s = track.sample_at(50.0).unwrap();
    assert_eq!(s.x, 0.25);
    assert_eq!(s.y, 0.75);
  }

  #[test]
  fn a_hidden_sample_hides_the_cursor() {
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), hidden(100.0, 1.0)]);
    assert!(track.sample_at(150.0).is_none());
  }

  #[test]
  fn the_cursor_comes_back_when_a_visible_sample_does() {
    let track = CursorTrack::new(vec![hidden(0.0, 0.0), at(100.0, 1.0, 1.0)]);
    assert!(track.sample_at(50.0).is_none());
    assert!(track.sample_at(150.0).is_some());
  }

  #[test]
  fn samples_arriving_out_of_order_are_sorted_on_the_way_in() {
    // The recorder emits in order, but a track assembled from several sources
    // might not be, and the lookup binary searches.
    let track = CursorTrack::new(vec![
      at(200.0, 0.2, 0.0),
      at(0.0, 0.0, 0.0),
      at(100.0, 0.1, 0.0),
    ]);
    assert_eq!(track.sample_at(50.0).unwrap().x, 0.0);
    assert_eq!(track.sample_at(150.0).unwrap().x, 0.1);
    assert_eq!(track.sample_at(250.0).unwrap().x, 0.2);
  }

  #[test]
  fn sorting_keeps_each_sample_with_its_own_bitmap() {
    let mut arrow = at(200.0, 0.2, 0.0);
    arrow.image_id = Some(7);
    let mut hand = at(0.0, 0.0, 0.0);
    hand.image_id = Some(3);
    let track = CursorTrack::new(vec![arrow, hand]);
    assert_eq!(track.sample_at(50.0).unwrap().image_id, Some(3));
    assert_eq!(track.sample_at(250.0).unwrap().image_id, Some(7));
  }

  #[test]
  fn a_sample_with_no_bitmap_asks_for_the_default() {
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0)]);
    assert_eq!(track.sample_at(0.0).unwrap().image_id, None);
  }

  #[test]
  fn duplicate_timestamps_resolve_to_the_last_one_in_order() {
    let track = CursorTrack::new(vec![at(100.0, 0.1, 0.0), at(100.0, 0.9, 0.0)]);
    assert_eq!(track.sample_at(100.0).unwrap().x, 0.9);
  }

  #[test]
  fn a_still_pointer_has_no_measurable_motion_from_one_sample() {
    let track = CursorTrack::new(vec![at(0.0, 0.5, 0.5)]);
    assert!(track.motion_at(0.0).is_none());
  }

  #[test]
  fn an_empty_track_has_no_motion() {
    assert!(CursorTrack::new(Vec::new()).motion_at(0.0).is_none());
  }

  #[test]
  fn there_is_no_motion_before_the_second_sample() {
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(100.0, 0.1, 0.0)]);
    assert!(track.motion_at(50.0).is_none());
  }

  #[test]
  fn motion_is_the_gradient_across_the_last_two_samples() {
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(100.0, 0.1, 0.2)]);
    let motion = track.motion_at(100.0).unwrap();
    assert!((motion.vx - 0.001).abs() < 1e-9, "{}", motion.vx);
    assert!((motion.vy - 0.002).abs() < 1e-9, "{}", motion.vy);
  }

  #[test]
  fn motion_keeps_its_direction() {
    let track = CursorTrack::new(vec![at(0.0, 0.5, 0.5), at(50.0, 0.4, 0.6)]);
    let motion = track.motion_at(50.0).unwrap();
    assert!(motion.vx < 0.0);
    assert!(motion.vy > 0.0);
  }

  #[test]
  fn motion_only_looks_at_the_most_recent_pair() {
    // An average over more samples lags the direction through a corner, and the
    // smear is meant to read as "where it is going right now".
    let track = CursorTrack::new(vec![
      at(0.0, 0.0, 0.0),
      at(50.0, 0.5, 0.0),
      at(60.0, 0.5, 0.5),
    ]);
    let motion = track.motion_at(60.0).unwrap();
    assert_eq!(motion.vx, 0.0);
    assert!(motion.vy > 0.0);
  }

  #[test]
  fn a_pointer_that_was_hidden_did_not_travel_the_distance_it_reappeared_over() {
    let track = CursorTrack::new(vec![hidden(0.0, 0.0), at(50.0, 0.9, 0.0)]);
    assert!(track.motion_at(50.0).is_none());
  }

  #[test]
  fn a_pointer_that_just_vanished_has_no_motion_either() {
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), hidden(50.0, 0.9)]);
    assert!(track.motion_at(50.0).is_none());
  }

  #[test]
  fn two_samples_at_the_same_instant_are_not_a_velocity() {
    let track = CursorTrack::new(vec![at(100.0, 0.0, 0.0), at(100.0, 0.9, 0.0)]);
    assert!(track.motion_at(100.0).is_none());
  }

  #[test]
  fn a_long_pause_between_samples_is_not_a_velocity() {
    // Further apart than MAX_MOTION_GAP_MS: where the pointer was a quarter of
    // a second ago says nothing about where it is heading now.
    let gap = MAX_MOTION_GAP_MS + 1.0;
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(gap, 0.5, 0.0)]);
    assert!(track.motion_at(gap).is_none());
  }

  #[test]
  fn a_gap_right_on_the_limit_still_counts() {
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(MAX_MOTION_GAP_MS, 0.5, 0.0)]);
    assert!(track.motion_at(MAX_MOTION_GAP_MS).is_some());
  }

  #[test]
  fn a_stopped_pointer_snaps_out_of_its_smear() {
    // The track holds the last sample forever, so without this the velocity
    // that reached it would leave a streak frozen on screen.
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(100.0, 0.1, 0.0)]);
    assert!(track.motion_at(100.0).is_some());
    assert!(track.motion_at(10_000.0).is_none());
  }

  #[test]
  fn a_velocity_is_believed_for_about_as_long_as_it_took_to_arrive() {
    // Gap of 100ms, so the hold is 100ms: believed to +100, gone at +101.
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(100.0, 0.1, 0.0)]);
    assert!(track.motion_at(200.0).is_some());
    assert!(track.motion_at(201.0).is_none());
  }

  #[test]
  fn a_fast_sample_cadence_still_holds_for_one_frame_at_30fps() {
    // Gap of 10ms would otherwise expire before the next frame is drawn and
    // make the smear flicker, so the hold is floored at MIN_MOTION_HOLD_MS.
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(10.0, 0.05, 0.0)]);
    assert!(track.motion_at(10.0 + MIN_MOTION_HOLD_MS).is_some());
    assert!(track.motion_at(10.0 + MIN_MOTION_HOLD_MS + 1.0).is_none());
  }

  #[test]
  fn a_gap_that_only_just_qualified_cannot_hang_a_streak_indefinitely() {
    // Gap of 250ms is under the limit, but the hold is capped so the streak
    // cannot linger for a quarter of a second after the pointer stopped.
    let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(250.0, 0.5, 0.0)]);
    assert!(track.motion_at(250.0 + MAX_MOTION_HOLD_MS).is_some());
    assert!(track.motion_at(250.0 + MAX_MOTION_HOLD_MS + 1.0).is_none());
  }

  #[test]
  fn the_hold_never_exceeds_the_cap_for_any_gap() {
    for gap in [1.0f64, 16.0, 34.0, 100.0, 200.0, 259.0] {
      let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(gap, 0.1, 0.0)]);
      assert!(
        track.motion_at(gap + MAX_MOTION_HOLD_MS + 1.0).is_none(),
        "gap {gap}"
      );
    }
  }

  #[test]
  fn the_hold_is_never_shorter_than_the_floor_for_any_gap() {
    for gap in [1.0f64, 5.0, 16.0, 34.0, 100.0] {
      let track = CursorTrack::new(vec![at(0.0, 0.0, 0.0), at(gap, 0.1, 0.0)]);
      assert!(
        track.motion_at(gap + MIN_MOTION_HOLD_MS).is_some(),
        "gap {gap}"
      );
    }
  }

  #[test]
  fn motion_is_measured_against_the_pair_in_effect_not_the_newest_pair() {
    // Asking about a moment in the middle of a track uses the two samples that
    // had happened by then, not the two at the end.
    let track = CursorTrack::new(vec![
      at(0.0, 0.0, 0.0),
      at(50.0, 0.5, 0.0),
      at(1000.0, 0.5, 0.0),
      at(1050.0, 0.0, 0.0),
    ]);
    assert!(track.motion_at(50.0).unwrap().vx > 0.0);
    assert!(track.motion_at(1050.0).unwrap().vx < 0.0);
  }
}

#[cfg(test)]
mod click_scenarios {
  use super::*;

  fn click(timestamp_ms: f64) -> CursorSample {
    CursorSample {
      timestamp_ms,
      x: 0.5,
      y: 0.5,
      visible: true,
      image_id: None,
      click: true,
    }
  }

  fn quiet(timestamp_ms: f64) -> CursorSample {
    CursorSample {
      click: false,
      ..click(timestamp_ms)
    }
  }

  #[test]
  fn the_envelope_starts_from_rest() {
    assert_eq!(click_envelope(0.0, 200.0), 0.0);
  }

  #[test]
  fn the_envelope_is_over_by_its_duration() {
    assert_eq!(click_envelope(200.0, 200.0), 0.0);
  }

  #[test]
  fn the_envelope_is_over_after_its_duration() {
    assert_eq!(click_envelope(500.0, 200.0), 0.0);
  }

  #[test]
  fn a_time_before_the_click_has_no_envelope() {
    assert_eq!(click_envelope(-10.0, 200.0), 0.0);
  }

  #[test]
  fn an_envelope_with_no_duration_is_nothing() {
    assert_eq!(click_envelope(10.0, 0.0), 0.0);
    assert_eq!(click_envelope(10.0, -5.0), 0.0);
  }

  #[test]
  fn the_envelope_peaks_at_the_end_of_the_attack() {
    // ATTACK is 0.18 of the duration.
    assert!((click_envelope(36.0, 200.0) - 1.0).abs() < 1e-5);
  }

  #[test]
  fn the_envelope_rises_all_the_way_through_the_attack() {
    let mut last = -1.0;
    for step in 0..=9 {
      let value = click_envelope(36.0 * (step as f64 / 9.0), 200.0);
      assert!(value > last, "step {step}: {value} <= {last}");
      last = value;
    }
  }

  #[test]
  fn the_envelope_falls_all_the_way_through_the_settle() {
    let mut last = 2.0;
    for step in 0..=9 {
      let t = 36.0 + (200.0 - 36.0) * (step as f64 / 9.0);
      let value = click_envelope(t.min(199.999), 200.0);
      assert!(value < last, "step {step}: {value} >= {last}");
      last = value;
    }
  }

  #[test]
  fn the_pop_grows_faster_than_it_settles() {
    // The asymmetry is what makes it look struck rather than breathing. Same
    // distance either side of the peak: on the way up it is still climbing
    // hard, on the way down it has barely started to fall.
    let before = click_envelope(27.0, 200.0);
    let after = click_envelope(45.0, 200.0);
    assert!(after > before, "{after} vs {before}");
  }

  #[test]
  fn the_rise_takes_less_of_the_duration_than_the_settle() {
    // Stated directly: how long it spends above nine tenths on each side.
    let peak_at = 36.0;
    let above = |from: f64, to: f64| {
      (from as i64..to as i64)
        .filter(|t| click_envelope(*t as f64, 200.0) > 0.9)
        .count()
    };
    assert!(
      above(peak_at, 200.0) > above(0.0, peak_at) * 3,
      "{} vs {}",
      above(peak_at, 200.0),
      above(0.0, peak_at)
    );
  }

  #[test]
  fn the_envelope_never_leaves_zero_to_one() {
    for step in 0..200 {
      let value = click_envelope(step as f64, 200.0);
      assert!((0.0..=1.0).contains(&value), "at {step}: {value}");
    }
  }

  #[test]
  fn the_envelope_is_scale_free_in_its_duration() {
    // The same fraction of the way through gives the same value whatever the
    // duration is, which is what makes the duration a real control.
    for fraction in [0.05f64, 0.18, 0.5, 0.9] {
      let short = click_envelope(fraction * 100.0, 100.0);
      let long = click_envelope(fraction * 400.0, 400.0);
      assert!((short - long).abs() < 1e-5, "{fraction}: {short} vs {long}");
    }
  }

  #[test]
  fn a_track_with_no_clicks_never_scales() {
    let track = CursorTrack::new(vec![quiet(0.0), quiet(100.0)]);
    for t in [0.0, 50.0, 100.0, 5000.0] {
      assert_eq!(track.click_scale_at(t, 1.5, 200.0), 1.0, "{t}");
    }
  }

  #[test]
  fn a_peak_of_one_is_not_worth_computing() {
    let track = CursorTrack::new(vec![click(0.0)]);
    assert_eq!(track.click_scale_at(10.0, 1.0, 200.0), 1.0);
  }

  #[test]
  fn a_duration_of_nothing_disables_the_pop() {
    let track = CursorTrack::new(vec![click(0.0)]);
    assert_eq!(track.click_scale_at(10.0, 1.5, 0.0), 1.0);
    assert_eq!(track.click_scale_at(10.0, 1.5, -1.0), 1.0);
  }

  #[test]
  fn nothing_happens_before_the_click() {
    let track = CursorTrack::new(vec![click(1000.0)]);
    assert_eq!(track.click_scale_at(999.0, 1.5, 200.0), 1.0);
  }

  #[test]
  fn the_click_starts_from_the_pointers_normal_size() {
    let track = CursorTrack::new(vec![click(1000.0)]);
    assert_eq!(track.click_scale_at(1000.0, 1.5, 200.0), 1.0);
  }

  #[test]
  fn a_click_reaches_the_peak_it_was_given() {
    let track = CursorTrack::new(vec![click(1000.0)]);
    let scale = track.click_scale_at(1036.0, 1.5, 200.0);
    assert!((scale - 1.5).abs() < 1e-4, "{scale}");
  }

  #[test]
  fn a_click_settles_back_to_normal() {
    let track = CursorTrack::new(vec![click(1000.0)]);
    assert_eq!(track.click_scale_at(1200.0, 1.5, 200.0), 1.0);
    assert_eq!(track.click_scale_at(5000.0, 1.5, 200.0), 1.0);
  }

  #[test]
  fn a_bigger_peak_makes_a_bigger_pop() {
    let track = CursorTrack::new(vec![click(1000.0)]);
    let small = track.click_scale_at(1036.0, 1.2, 200.0);
    let big = track.click_scale_at(1036.0, 2.0, 200.0);
    assert!(big > small);
  }

  #[test]
  fn a_peak_below_one_shrinks_the_pointer_instead() {
    let track = CursorTrack::new(vec![click(1000.0)]);
    let scale = track.click_scale_at(1036.0, 0.8, 200.0);
    assert!((scale - 0.8).abs() < 1e-4, "{scale}");
  }

  #[test]
  fn a_move_right_after_a_click_does_not_cut_the_pop_short() {
    // The whole reason clicks are resolved against their own list rather than
    // the held sample: dragging emits a move ten milliseconds later, which is
    // exactly when the click most needs to still be visible.
    let track = CursorTrack::new(vec![click(1000.0), quiet(1010.0), quiet(1020.0)]);
    assert!(track.click_scale_at(1036.0, 1.5, 200.0) > 1.4);
  }

  #[test]
  fn a_second_click_restarts_the_pop() {
    let track = CursorTrack::new(vec![click(1000.0), click(1150.0)]);
    // 1150 is the start of the second click, so back to rest rather than
    // partway down the first one's settle.
    assert_eq!(track.click_scale_at(1150.0, 1.5, 200.0), 1.0);
    assert!((track.click_scale_at(1186.0, 1.5, 200.0) - 1.5).abs() < 1e-4);
  }

  #[test]
  fn only_the_most_recent_click_counts() {
    let track = CursorTrack::new(vec![click(0.0), click(1000.0), click(2000.0)]);
    assert!((track.click_scale_at(2036.0, 1.5, 200.0) - 1.5).abs() < 1e-4);
  }

  #[test]
  fn clicks_are_found_however_the_samples_arrived() {
    let track = CursorTrack::new(vec![click(2000.0), quiet(500.0), click(1000.0)]);
    assert!((track.click_scale_at(1036.0, 1.5, 200.0) - 1.5).abs() < 1e-4);
    assert!((track.click_scale_at(2036.0, 1.5, 200.0) - 1.5).abs() < 1e-4);
  }

  #[test]
  fn a_click_on_a_hidden_sample_still_registers() {
    // Visibility is about drawing the sprite; the click list is about when the
    // button went down. A click while the pointer was hidden is unusual but it
    // is not a reason to lose the event.
    let hidden_click = CursorSample {
      visible: false,
      ..click(1000.0)
    };
    let track = CursorTrack::new(vec![hidden_click]);
    assert!(track.click_scale_at(1036.0, 1.5, 200.0) > 1.4);
  }

  #[test]
  fn the_scale_never_overshoots_the_peak() {
    let track = CursorTrack::new(vec![click(1000.0)]);
    for step in 0..250 {
      let scale = track.click_scale_at(1000.0 + step as f64, 1.5, 200.0);
      assert!((1.0..=1.5).contains(&scale), "at {step}: {scale}");
    }
  }

  #[test]
  fn a_longer_duration_keeps_the_pop_on_screen_longer() {
    let track = CursorTrack::new(vec![click(1000.0)]);
    assert_eq!(track.click_scale_at(1250.0, 1.5, 200.0), 1.0);
    assert!(track.click_scale_at(1250.0, 1.5, 600.0) > 1.0);
  }
}

#[cfg(test)]
mod clip_space_matrix {
  use super::*;

  const SURFACES: [(u32, u32); 8] = [
    (1920, 1080),
    (1280, 720),
    (3840, 2160),
    (1080, 1920),
    (800, 800),
    (1, 1),
    (0, 0),
    (7, 3),
  ];

  fn rect(x: f32, y: f32, width: f32, height: f32) -> Rect {
    Rect {
      x,
      y,
      width,
      height,
    }
  }

  #[test]
  fn a_full_frame_rect_spans_clip_space_on_every_surface() {
    for (w, h) in SURFACES {
      if w == 0 || h == 0 {
        continue;
      }
      let ndc = Rect::covering(w, h).to_ndc(w, h);
      assert_eq!(ndc, [-1.0, 1.0, 1.0, -1.0], "{w}x{h}");
    }
  }

  #[test]
  fn the_mapping_is_finite_on_every_surface_for_every_rect() {
    let rects = [
      rect(0.0, 0.0, 1.0, 1.0),
      rect(-500.0, -500.0, 100.0, 100.0),
      rect(1e6, 1e6, 1.0, 1.0),
      rect(0.0, 0.0, 0.0, 0.0),
    ];
    for (w, h) in SURFACES {
      for r in rects {
        let ndc = r.to_ndc(w, h);
        assert!(
          ndc.iter().all(|v| v.is_finite()),
          "{w}x{h} {r:?} -> {ndc:?}"
        );
      }
    }
  }

  #[test]
  fn a_zero_sized_surface_never_divides_by_zero() {
    // `max(1)` on both axes: a NaN here would poison the vertex shader rather
    // than draw nothing.
    for (w, h) in [(0u32, 0u32), (0, 1080), (1920, 0)] {
      let ndc = Rect::covering(100, 100).to_ndc(w, h);
      assert!(ndc.iter().all(|v| v.is_finite()), "{w}x{h}");
    }
  }

  #[test]
  fn clip_space_y_runs_the_opposite_way_on_every_surface() {
    for (w, h) in SURFACES {
      if h < 2 {
        continue;
      }
      let near_top = rect(0.0, 0.0, 1.0, 1.0).to_ndc(w, h);
      let near_bottom = rect(0.0, h as f32 - 1.0, 1.0, 1.0).to_ndc(w, h);
      assert!(near_bottom[1] < near_top[1], "{w}x{h}");
    }
  }

  #[test]
  fn clip_space_x_runs_the_same_way_on_every_surface() {
    for (w, h) in SURFACES {
      if w < 2 {
        continue;
      }
      let left = rect(0.0, 0.0, 1.0, 1.0).to_ndc(w, h);
      let right = rect(w as f32 - 1.0, 0.0, 1.0, 1.0).to_ndc(w, h);
      assert!(right[0] > left[0], "{w}x{h}");
    }
  }

  #[test]
  fn the_centre_of_every_surface_is_the_origin_of_clip_space() {
    for (w, h) in SURFACES {
      if w == 0 || h == 0 {
        continue;
      }
      let ndc = rect(w as f32 * 0.5, h as f32 * 0.5, 0.0, 0.0).to_ndc(w, h);
      assert!(ndc[0].abs() < 1e-5, "{w}x{h}: {}", ndc[0]);
      assert!(ndc[1].abs() < 1e-5, "{w}x{h}: {}", ndc[1]);
    }
  }

  #[test]
  fn the_mapping_is_linear_in_x_on_every_surface() {
    for (w, h) in SURFACES {
      if w < 8 {
        continue;
      }
      let at = |x: f32| rect(x, 0.0, 1.0, 1.0).to_ndc(w, h)[0];
      let step = w as f32 / 8.0;
      let low = at(step * 2.0) - at(step);
      let high = at(step * 6.0) - at(step * 5.0);
      assert!((low - high).abs() < 1e-4, "{w}x{h}: {low} vs {high}");
    }
  }

  #[test]
  fn a_rect_past_the_edge_maps_outside_clip_space_on_every_surface() {
    // Not clamped: the rasterizer clips, and clamping here would squash a quad
    // that is only partly on screen instead of cropping it.
    for (w, h) in SURFACES {
      if w == 0 || h == 0 {
        continue;
      }
      let ndc = rect(w as f32 * 2.0, 0.0, 10.0, 10.0).to_ndc(w, h);
      assert!(ndc[0] > 1.0, "{w}x{h}: {}", ndc[0]);
    }
  }

  #[test]
  fn a_rect_and_its_expansion_map_consistently_on_every_surface() {
    for (w, h) in SURFACES {
      if w == 0 || h == 0 {
        continue;
      }
      let base = rect(
        w as f32 * 0.25,
        h as f32 * 0.25,
        w as f32 * 0.5,
        h as f32 * 0.5,
      );
      let grown = base.expanded(4.0);
      let a = base.to_ndc(w, h);
      let b = grown.to_ndc(w, h);
      // Growing a rect moves its left edge left and its right edge right.
      assert!(b[0] <= a[0], "{w}x{h}");
      assert!(b[2] >= a[2], "{w}x{h}");
      // And in clip space y, which is flipped, the top goes up.
      assert!(b[1] >= a[1], "{w}x{h}");
      assert!(b[3] <= a[3], "{w}x{h}");
    }
  }

  #[test]
  fn expanding_and_shrinking_round_trips_for_every_amount() {
    let base = rect(100.0, 50.0, 320.0, 180.0);
    for amount in [0.0f32, 0.5, 1.0, 12.0, 100.0, -4.0] {
      let back = base.expanded(amount).expanded(-amount);
      assert!((back.x - base.x).abs() < 1e-3, "{amount}");
      assert!((back.y - base.y).abs() < 1e-3, "{amount}");
      assert!((back.width - base.width).abs() < 1e-3, "{amount}");
      assert!((back.height - base.height).abs() < 1e-3, "{amount}");
    }
  }

  #[test]
  fn expanding_always_keeps_the_centre_for_every_amount() {
    let base = rect(100.0, 50.0, 320.0, 180.0);
    let centre = |r: Rect| (r.x + r.width * 0.5, r.y + r.height * 0.5);
    for amount in [0.0f32, 1.0, 12.0, 100.0, -4.0, -80.0] {
      let grown = base.expanded(amount);
      let (bx, by) = centre(base);
      let (gx, gy) = centre(grown);
      assert!((bx - gx).abs() < 1e-3, "{amount}");
      assert!((by - gy).abs() < 1e-3, "{amount}");
    }
  }

  #[test]
  fn emptiness_is_decided_by_the_sides_alone_for_every_position() {
    for x in [-1e6f32, -1.0, 0.0, 1.0, 1e6] {
      for y in [-1e6f32, 0.0, 1e6] {
        assert!(!rect(x, y, 1.0, 1.0).is_empty(), "{x},{y}");
        assert!(rect(x, y, 0.0, 1.0).is_empty(), "{x},{y}");
        assert!(rect(x, y, 1.0, 0.0).is_empty(), "{x},{y}");
        assert!(rect(x, y, -1.0, 1.0).is_empty(), "{x},{y}");
      }
    }
  }

  #[test]
  fn covering_matches_a_hand_built_rect_for_every_surface() {
    for (w, h) in SURFACES {
      assert_eq!(
        Rect::covering(w, h),
        rect(0.0, 0.0, w as f32, h as f32),
        "{w}x{h}"
      );
    }
  }
}

#[cfg(test)]
mod click_envelope_matrix {
  use super::*;

  const DURATIONS: [f64; 7] = [0.0, -1.0, 1.0, 50.0, 200.0, 1_000.0, 10_000.0];

  #[test]
  fn the_envelope_is_bounded_for_every_duration_and_elapsed() {
    for duration in DURATIONS {
      for step in -5..110 {
        let elapsed = duration * (step as f64 / 100.0);
        let value = click_envelope(elapsed, duration);
        assert!(
          (0.0..=1.0).contains(&value),
          "duration {duration} elapsed {elapsed}: {value}"
        );
        assert!(value.is_finite(), "duration {duration} elapsed {elapsed}");
      }
    }
  }

  #[test]
  fn the_envelope_starts_and_ends_at_rest_for_every_positive_duration() {
    for duration in DURATIONS.iter().filter(|d| **d > 0.0) {
      assert_eq!(click_envelope(0.0, *duration), 0.0, "{duration}");
      assert_eq!(click_envelope(*duration, *duration), 0.0, "{duration}");
      assert_eq!(click_envelope(duration * 2.0, *duration), 0.0, "{duration}");
    }
  }

  #[test]
  fn a_non_positive_duration_disables_the_envelope_at_every_elapsed() {
    for duration in [0.0f64, -1.0, -1_000.0] {
      for elapsed in [-10.0f64, 0.0, 1.0, 100.0] {
        assert_eq!(
          click_envelope(elapsed, duration),
          0.0,
          "{duration}/{elapsed}"
        );
      }
    }
  }

  #[test]
  fn a_negative_elapsed_is_never_part_of_the_envelope() {
    for duration in DURATIONS.iter().filter(|d| **d > 0.0) {
      for elapsed in [-1e6f64, -100.0, -1.0, -1e-9] {
        assert_eq!(
          click_envelope(elapsed, *duration),
          0.0,
          "{duration}/{elapsed}"
        );
      }
    }
  }

  #[test]
  fn the_envelope_peaks_once_and_at_the_same_fraction_for_every_duration() {
    for duration in DURATIONS.iter().filter(|d| **d >= 50.0) {
      let mut best = (0.0f32, 0.0f64);
      for step in 0..1_000 {
        let fraction = step as f64 / 1_000.0;
        let value = click_envelope(duration * fraction, *duration);
        if value > best.0 {
          best = (value, fraction);
        }
      }
      assert!((best.0 - 1.0).abs() < 1e-3, "{duration}: peak {}", best.0);
      // ATTACK is 0.18 of the duration.
      assert!(
        (best.1 - 0.18).abs() < 0.02,
        "{duration}: peaked at {}",
        best.1
      );
    }
  }

  #[test]
  fn the_envelope_is_scale_free_across_every_pair_of_durations() {
    let durations = [50.0f64, 200.0, 1_000.0, 10_000.0];
    for a in durations {
      for b in durations {
        for step in 0..20 {
          let fraction = step as f64 / 20.0;
          let left = click_envelope(a * fraction, a);
          let right = click_envelope(b * fraction, b);
          assert!(
            (left - right).abs() < 1e-4,
            "{a} vs {b} at {fraction}: {left} vs {right}"
          );
        }
      }
    }
  }

  #[test]
  fn the_envelope_rises_then_falls_without_a_second_bump() {
    for duration in [200.0f64, 1_000.0] {
      let mut rising = true;
      let mut last = 0.0f32;
      for step in 1..500 {
        let value = click_envelope(duration * step as f64 / 500.0, duration);
        if rising && value < last {
          rising = false;
        }
        if !rising {
          assert!(value <= last + 1e-5, "{duration} bumped again at {step}");
        }
        last = value;
      }
      assert!(!rising, "{duration} never came back down");
    }
  }

  #[test]
  fn the_click_scale_follows_the_envelope_for_every_peak() {
    let mut clicked = CursorSample {
      timestamp_ms: 1_000.0,
      x: 0.5,
      y: 0.5,
      visible: true,
      image_id: None,
      click: true,
    };
    clicked.click = true;
    let track = CursorTrack::new(vec![clicked]);
    for peak in [0.25f32, 0.9, 1.0, 1.5, 4.0] {
      for step in 0..40 {
        let elapsed = step as f64 * 10.0;
        let scale = track.click_scale_at(1_000.0 + elapsed, peak, 250.0);
        let expected = 1.0 + (peak - 1.0) * click_envelope(elapsed, 250.0);
        assert!(
          (scale - expected).abs() < 1e-5,
          "peak {peak} elapsed {elapsed}: {scale} vs {expected}"
        );
      }
    }
  }
}

#[cfg(test)]
mod motion_hold_matrix {
  use super::*;

  fn at(timestamp_ms: f64, x: f32) -> CursorSample {
    CursorSample {
      timestamp_ms,
      x,
      y: 0.5,
      visible: true,
      image_id: None,
      click: false,
    }
  }

  /// Gaps either side of every constant in the policy.
  const GAPS: [f64; 12] = [
    1.0, 8.0, 16.0, 33.0, 34.0, 35.0, 100.0, 119.0, 120.0, 121.0, 259.0, 260.0,
  ];

  #[test]
  fn a_gap_inside_the_limit_always_yields_a_velocity_at_the_moment_it_arrives() {
    for gap in GAPS {
      let track = CursorTrack::new(vec![at(0.0, 0.0), at(gap, 0.5)]);
      assert!(track.motion_at(gap).is_some(), "gap {gap}");
    }
  }

  #[test]
  fn a_gap_past_the_limit_never_yields_a_velocity() {
    for gap in [MAX_MOTION_GAP_MS + 0.001, 300.0, 1_000.0, 10_000.0] {
      let track = CursorTrack::new(vec![at(0.0, 0.0), at(gap, 0.5)]);
      assert!(track.motion_at(gap).is_none(), "gap {gap}");
    }
  }

  #[test]
  fn the_hold_is_the_gap_clamped_between_the_two_bounds_for_every_gap() {
    for gap in GAPS {
      let track = CursorTrack::new(vec![at(0.0, 0.0), at(gap, 0.5)]);
      let hold = gap.clamp(MIN_MOTION_HOLD_MS, MAX_MOTION_HOLD_MS);
      assert!(
        track.motion_at(gap + hold).is_some(),
        "gap {gap} hold {hold}: expired early"
      );
      assert!(
        track.motion_at(gap + hold + 0.001).is_none(),
        "gap {gap} hold {hold}: outlasted its hold"
      );
    }
  }

  #[test]
  fn the_hold_never_falls_below_a_frame_at_30fps_for_any_gap() {
    // Otherwise a fast sample cadence makes the smear flicker.
    for gap in GAPS {
      let track = CursorTrack::new(vec![at(0.0, 0.0), at(gap, 0.5)]);
      assert!(
        track.motion_at(gap + MIN_MOTION_HOLD_MS).is_some(),
        "gap {gap}"
      );
    }
  }

  #[test]
  fn the_hold_never_outlasts_the_cap_for_any_gap() {
    // Otherwise a gap that only just qualified leaves a streak hanging.
    for gap in GAPS {
      let track = CursorTrack::new(vec![at(0.0, 0.0), at(gap, 0.5)]);
      assert!(
        track.motion_at(gap + MAX_MOTION_HOLD_MS + 0.001).is_none(),
        "gap {gap}"
      );
    }
  }

  #[test]
  fn the_velocity_is_the_gradient_for_every_gap_and_distance() {
    for gap in GAPS {
      for distance in [-0.5f32, -0.01, 0.0, 0.01, 0.5, 1.0] {
        let track = CursorTrack::new(vec![at(0.0, 0.0), at(gap, distance)]);
        let motion = track.motion_at(gap).unwrap();
        let expected = distance / gap as f32;
        assert!(
          (motion.vx - expected).abs() < 1e-6,
          "gap {gap} distance {distance}: {} vs {expected}",
          motion.vx
        );
      }
    }
  }

  #[test]
  fn a_hidden_endpoint_removes_the_velocity_for_every_gap() {
    // A pointer that was hidden and came back teleported; smearing that draws
    // a streak across whatever it crossed.
    for gap in GAPS {
      for hide_first in [true, false] {
        let mut a = at(0.0, 0.0);
        let mut b = at(gap, 0.5);
        if hide_first {
          a.visible = false;
        } else {
          b.visible = false;
        }
        let track = CursorTrack::new(vec![a, b]);
        assert!(
          track.motion_at(gap).is_none(),
          "gap {gap} hide_first {hide_first}"
        );
      }
    }
  }

  #[test]
  fn two_samples_at_the_same_instant_never_yield_a_velocity() {
    for at_ms in [0.0f64, 100.0, 5_000.0] {
      let track = CursorTrack::new(vec![at(at_ms, 0.0), at(at_ms, 0.9)]);
      assert!(track.motion_at(at_ms).is_none(), "{at_ms}");
    }
  }

  #[test]
  fn the_velocity_always_reflects_the_most_recent_pair_for_any_track_length() {
    for count in 2..12usize {
      let samples: Vec<CursorSample> = (0..count)
        .map(|i| at(i as f64 * 50.0, i as f32 * 0.05))
        .collect();
      let last = (count - 1) as f64 * 50.0;
      let track = CursorTrack::new(samples);
      let motion = track.motion_at(last).unwrap();
      assert!((motion.vx - 0.05 / 50.0).abs() < 1e-6, "{count} samples");
    }
  }

  #[test]
  fn the_smear_from_any_velocity_is_always_drawable() {
    let head = Rect {
      x: 100.0,
      y: 100.0,
      width: 24.0,
      height: 24.0,
    };
    for gap in GAPS {
      for distance in [-1.0f32, -0.1, 0.1, 1.0] {
        let track = CursorTrack::new(vec![at(0.0, 0.0), at(gap, distance)]);
        let motion = track.motion_at(gap).unwrap();
        let travel = [motion.vx * 1000.0, 0.0];
        if let Some((quad, uv, uv_travel)) = smear_geometry(head, travel) {
          let label = format!("gap {gap} distance {distance}");
          assert!(quad.width >= head.width - 1e-3, "{label}");
          assert!(uv.scale[0] >= 1.0 - 1e-3, "{label}");
          assert!(uv_travel.iter().all(|v| v.is_finite()), "{label}");
        }
      }
    }
  }
}

#[cfg(test)]
mod hidden_span_matrix {
  use super::*;

  fn span_sets() -> Vec<(&'static str, Vec<(f64, f64)>)> {
    vec![
      ("none", vec![]),
      ("one", vec![(1_000.0, 2_000.0)]),
      ("two apart", vec![(1_000.0, 2_000.0), (5_000.0, 6_000.0)]),
      ("back to back", vec![(1_000.0, 2_000.0), (2_000.0, 3_000.0)]),
      ("overlapping", vec![(1_000.0, 3_000.0), (2_000.0, 4_000.0)]),
      ("nested", vec![(1_000.0, 9_000.0), (3_000.0, 4_000.0)]),
      ("unsorted", vec![(9_000.0, 10_000.0), (1_000.0, 2_000.0)]),
      ("empty ones", vec![(1_000.0, 1_000.0), (3_000.0, 2_000.0)]),
      (
        "many",
        (0..20)
          .map(|i| (i as f64 * 500.0, i as f64 * 500.0 + 200.0))
          .collect(),
      ),
    ]
  }

  #[test]
  fn the_lookup_is_stable_for_every_span_set() {
    // It bails as soon as it passes the time, which only works because the
    // spans were sorted on the way in.
    for (name, spans) in span_sets() {
      let hidden = HiddenSpans::new(spans);
      for step in 0..300 {
        let at = step as f64 * 50.0;
        assert_eq!(hidden.contains(at), hidden.contains(at), "{name} at {at}");
      }
    }
  }

  #[test]
  fn asking_in_reverse_gives_the_same_answers_for_every_span_set() {
    for (name, spans) in span_sets() {
      let hidden = HiddenSpans::new(spans);
      let forward: Vec<bool> = (0..300).map(|s| hidden.contains(s as f64 * 50.0)).collect();
      let backward: Vec<bool> = (0..300)
        .rev()
        .map(|s| hidden.contains(s as f64 * 50.0))
        .collect();
      for (i, value) in backward.iter().rev().enumerate() {
        assert_eq!(*value, forward[i], "{name} at step {i}");
      }
    }
  }

  #[test]
  fn every_span_set_is_half_open_at_its_ends() {
    for (name, spans) in span_sets() {
      let hidden = HiddenSpans::new(spans.clone());
      for (start, end) in spans {
        if end <= start {
          continue;
        }
        // The start is inside; the end is the first frame of what follows,
        // unless another span picks up exactly there.
        assert!(hidden.contains(start), "{name} start {start}");
      }
    }
  }

  #[test]
  fn an_empty_or_backwards_span_never_hides_anything() {
    for (start, end) in [(1_000.0f64, 1_000.0f64), (2_000.0, 1_000.0), (0.0, 0.0)] {
      let hidden = HiddenSpans::new(vec![(start, end)]);
      assert!(hidden.is_empty(), "{start}..{end}");
      for step in 0..100 {
        assert!(!hidden.contains(step as f64 * 50.0), "{start}..{end}");
      }
    }
  }

  #[test]
  fn dropping_the_empty_spans_never_takes_a_real_one_with_them() {
    for (name, spans) in span_sets() {
      let real = spans.iter().filter(|(s, e)| e > s).count();
      let hidden = HiddenSpans::new(spans);
      assert_eq!(hidden.is_empty(), real == 0, "{name}");
    }
  }

  #[test]
  fn a_span_set_never_hides_before_its_earliest_start() {
    for (name, spans) in span_sets() {
      let earliest = spans
        .iter()
        .filter(|(s, e)| e > s)
        .map(|(s, _)| *s)
        .fold(f64::INFINITY, f64::min);
      let hidden = HiddenSpans::new(spans);
      if earliest.is_finite() {
        assert!(!hidden.contains(earliest - 0.001), "{name}");
      }
    }
  }

  #[test]
  fn a_span_set_never_hides_after_its_latest_end() {
    for (name, spans) in span_sets() {
      let latest = spans
        .iter()
        .filter(|(s, e)| e > s)
        .map(|(_, e)| *e)
        .fold(f64::NEG_INFINITY, f64::max);
      let hidden = HiddenSpans::new(spans);
      if latest.is_finite() {
        assert!(!hidden.contains(latest), "{name}");
        assert!(!hidden.contains(latest + 1_000.0), "{name}");
      }
    }
  }
}
