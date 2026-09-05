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
  ps_smear: ID3D11PixelShader,
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
  /// The cursor again, stretched along its travel. Carries the forward offset
  /// in the sprite's own uv units -- see `ps_smear`.
  Smear([f32; 2]),
  /// A flat colour, no texture. Borders.
  Solid([f32; 4]),
}

impl Overlays {
  pub fn new(
    gpu: &Gpu,
    vs: ID3D11VertexShader,
    ps_overlay: ID3D11PixelShader,
    ps_sprite: ID3D11PixelShader,
    ps_smear: ID3D11PixelShader,
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

    // 24 floats: the rect, the mask, the grade, the uv sub-rect, the tint and
    // the smear vector.
    let constants = super::render::create_constant_buffer(gpu, 24 * 4)?;

    Ok(Self {
      vs,
      ps_overlay,
      ps_sprite,
      ps_smear,
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
          Fill::Smear(_) => &self.ps_smear,
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
    let smear = match quad.fill {
      Fill::Smear(offset) => offset,
      _ => [0.0, 0.0],
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
