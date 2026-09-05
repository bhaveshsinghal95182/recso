//! The render layer: everything that happens to a frame between decoding it and
//! deciding where it goes.
//!
//! It sits *before* the preview/export fork on purpose. Both consumers pull
//! from the same chain output, so a filter cannot look one way on screen and
//! another way in the file.
//!
//! ```text
//!   Decoder ──> RenderChain ──> fork ──┬──> preview  (BGRA, shared, Chromium)
//!                                      └──> exporter (NV12, encoder, MP4)
//! ```
//!
//! Internally everything is BGRA: NV12 comes in, converts once, effects run in
//! RGB, and the result goes out as BGRA for preview or converts back to NV12
//! for the encoder. Owning both directions means one colour matrix across the
//! whole round trip, and no hidden video processor in the export path.
//!
//! Decoded NV12 is kept per slot rather than in one shared staging texture.
//! That is what makes changing a filter cheap: the pixels are already here, so
//! a colour tweak re-renders them instead of seeking and decoding them again.

use windows::core::{Result, PCSTR};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::{
  ID3DBlob, D3D11_SRV_DIMENSION_TEXTURE2D, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST,
};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;

use crate::engine::composite::{
  fit_source, smear_geometry, CursorImages, CursorTrack, Fill, Grade, HiddenSpans, OverlayShape,
  Overlays, Quad, Rect, ShadowFill, SpriteTexture, UvRect, WebcamLayout,
};
use crate::engine::d3d::{gpu, Gpu};
use crate::engine::zoom::{lerp_rect, WebcamZoomState, WebcamZoomTrack, ZoomState, ZoomTrack};

const HLSL: &str = include_str!("shaders.hlsl");

/// Matches the editor's compositor default, so switching paths does not resize
/// the pointer.
const DEFAULT_CURSOR_SIZE_PX: f32 = 22.0;

/// How much of the pointer's travel the tail represents, at strength 1.
///
/// Roughly one frame at 30fps, which is the honest answer to "where was it when
/// this frame started" -- and the reason a smear reads as motion rather than as
/// a decoration is that it is the distance actually covered.
const SMEAR_TRAVEL_MS: f32 = 28.0;

/// The cap, in multiples of the pointer's drawn height.
///
/// Speed is unbounded -- a flick of the mouse crosses a 4K screen in a couple
/// of frames -- so an uncapped smear is a streak from one edge to the other,
/// which stops being a pointer. Four is long enough to look fast and short
/// enough to still read as the shape it came from.
const MAX_SMEAR_HEIGHTS: f32 = 4.0;

/// Below this there is nothing to see, and drawing it costs a shader that
/// samples the sprite thirty-two times to produce a pointer with a fuzzy edge.
const MIN_SMEAR_HEIGHTS: f32 = 0.15;

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

/// What fills the canvas behind the video.
///
/// An image rather than a family of shaders on purpose. The editor's
/// backgrounds are solid colours, two kinds of gradient, a cross-hatch pattern
/// and arbitrary images -- and every one of them is static for the whole
/// export. Reimplementing four generators in HLSL buys nothing over letting the
/// caller rasterise once and upload the result, and it would be four more
/// things that have to match the Canvas2D versions pixel for pixel.
pub enum Background {
  /// A flat colour. Straight to `ClearRenderTargetView`, so it costs nothing.
  Solid([f32; 4]),
  /// A pre-rendered image stretched over the canvas, over `clear` where it is
  /// transparent.
  Image {
    clear: [f32; 4],
    texture: SpriteTexture,
  },
}

impl Default for Background {
  /// Opaque black. Only visible at all once something insets the video.
  fn default() -> Self {
    Self::Solid([0.0, 0.0, 0.0, 1.0])
  }
}

impl Background {
  fn clear_colour(&self) -> [f32; 4] {
    match self {
      Self::Solid(colour) => *colour,
      Self::Image { clear, .. } => *clear,
    }
  }

  /// Upload a request, turning its pixels into a texture.
  ///
  /// Call this on the thread that renders. `SpriteTexture::new` only touches
  /// the device, which is multithread-protected and so safe to call from
  /// anywhere -- but keeping every texture this chain owns created on one
  /// thread is one less thing to reason about, and it is what the cursor
  /// bitmap already does.
  pub fn build(request: BackgroundRequest) -> Result<Self> {
    let Some(image) = request.image else {
      return Ok(Self::Solid(request.clear));
    };

    Ok(Self::Image {
      clear: request.clear,
      texture: SpriteTexture::new(image.width, image.height, &image.pixels, 0.0, 0.0)?,
    })
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

  fn width(&self) -> f32 {
    1.0 - self.left - self.right
  }

  fn height(&self) -> f32 {
    1.0 - self.top - self.bottom
  }
}

/// Where the recording sits on the canvas, and what shape it is.
///
/// Pixel coordinates in the canvas, like `WebcamLayout` -- the padding
/// fraction, the scale and the centring are all resolved by the caller, so
/// there is one layout formula in the app rather than two that have to agree.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VideoLayout {
  pub rect: Rect,
  pub corner_radius: f32,
  pub border_width: f32,
  pub border_colour: [f32; 4],
}

impl VideoLayout {
  /// The video filling the whole canvas, square corners, no border. What the
  /// chain does before anyone sets a layout, and what a project with no
  /// background enabled wants.
  pub fn covering(width: u32, height: u32) -> Self {
    Self {
      rect: Rect::covering(width, height),
      corner_radius: 0.0,
      border_width: 0.0,
      border_colour: [0.0, 0.0, 0.0, 1.0],
    }
  }

  fn sanitized(mut self) -> Self {
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

/// One decoded frame, kept in NV12 with the views needed to sample it.
///
/// The decoder hands back a slice of a texture *array*, and building planar
/// views onto an array slice is fiddly and not uniformly supported. Copying
/// into a plain NV12 texture first removes that whole class of problem, and the
/// copy has to happen anyway to keep the pixels alive, because the decoder
/// reuses its slices.
struct Source {
  texture: ID3D11Texture2D,
  srv_y: ID3D11ShaderResourceView,
  srv_uv: ID3D11ShaderResourceView,
}

/// The webcam's own decode target and conversion scratch.
///
/// It runs at the camera's resolution, not the canvas's, so it needs its own
/// NV12 sources and its own BGRA intermediate before it can be drawn as a quad.
struct WebcamLayer {
  width: u32,
  height: u32,
  sources: Vec<Source>,
  /// Which slots currently hold a webcam frame. A camera at 30fps against a
  /// screen capture that only ticks when something changes will not have one
  /// for every slot.
  staged: Vec<bool>,
  bgra_rtv: ID3D11RenderTargetView,
  bgra_srv: ID3D11ShaderResourceView,
  #[allow(dead_code)]
  bgra: ID3D11Texture2D,
}

/// The camera as one slot's frame had it.
#[derive(Clone, Copy, Debug)]
struct StagedWebcam {
  /// False while a webcam cut is covering this instant.
  visible: bool,
  /// The box, already eased through any region that was in effect.
  rect: Rect,
  /// 0 is the box as laid out; 1 is the whole canvas.
  full_screen: f32,
}

impl Default for StagedWebcam {
  fn default() -> Self {
    Self {
      visible: true,
      rect: Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
      },
      full_screen: 0.0,
    }
  }
}

/// What was resolved for a slot at stage time: where the pointer goes, and
/// which bitmap that rectangle was measured against.
///
/// The bitmap matters as much as the rect. Size and hotspot offset both come
/// from the image, so a rect resolved against one shape and drawn with another
/// puts the pointer's tip in the wrong place.
#[derive(Clone, Copy)]
struct StagedCursor {
  rect: Rect,
  image_id: Option<u32>,
  /// Forward travel in canvas pixels over the tail's length, zero for none.
  /// Staged with the rest for the same reason: the pointer was moving when this
  /// frame was taken, and it still was when the frame is drawn again later.
  smear: [f32; 2],
}

pub struct RenderChain {
  /// Coded size of the *source*: what the NV12 textures are, macroblock padding
  /// included.
  source_width: u32,
  source_height: u32,

  /// Visible size of the source: the sub-rectangle of the coded frame that is
  /// real picture.
  ///
  /// Kept apart from the coded size because the two are used for different
  /// things and silently swapping them is a whole class of bug. Anything
  /// addressing texture memory uses the coded size; the video quad reads only
  /// this much of it, which is where the padding gets left behind.
  display_width: u32,
  display_height: u32,

  /// The canvas: what this chain actually outputs, and what every render target
  /// below is sized to.
  ///
  /// Fixed at construction rather than settable, because the player's pool is
  /// this size and its handles have already been handed to Chromium -- resizing
  /// would mean tearing down and re-doing that handshake. The *video's rect
  /// within* the canvas is what moves.
  canvas_width: u32,
  canvas_height: u32,

  vs: ID3D11VertexShader,
  ps_convert: ID3D11PixelShader,
  ps_to_y: ID3D11PixelShader,
  ps_to_uv: ID3D11PixelShader,
  sampler: ID3D11SamplerState,
  constants: ID3D11Buffer,

  /// One NV12 source per destination slot, so any frame the player still holds
  /// can be re-rendered without going back to the decoder.
  sources: Vec<Source>,

  /// The converted video, at the *source's* resolution, before it is placed on
  /// the canvas.
  ///
  /// One scratch rather than one per slot: a render composites a single slot
  /// and consumes this immediately. The per-slot state that has to survive is
  /// the NV12 above, not this.
  video_bgra_rtv: ID3D11RenderTargetView,
  video_bgra_srv: ID3D11ShaderResourceView,
  #[allow(dead_code)]
  video_bgra: ID3D11Texture2D,

  /// Where the video sits on the canvas, and the background behind it.
  layout: VideoLayout,
  background: Background,
  /// Which part of the recording is kept. `None` keeps all of it.
  crop: Option<SourceCrop>,

  /// The webcam layer, when a recording has one.
  ///
  /// Per-slot NV12 like the desktop, for the same reason: moving or resizing
  /// the webcam box has to re-render the frames already in the queue, not go
  /// back to the decoder for them.
  webcam: Option<WebcamLayer>,
  webcam_layout: WebcamLayout,
  /// Spans of the composition with no camera in them.
  webcam_hidden: HiddenSpans,
  /// Which of the three sits on top of which. Bottom first.
  layer_order: [Layer; 3],
  /// Spans where the camera changes size, or takes the whole frame.
  webcam_zoom: WebcamZoomTrack,
  /// What the camera was doing when each slot was staged.
  ///
  /// Per slot rather than read at draw time for the same reason the cursor's
  /// rect is: a re-render after a grading change has to put the frame back the
  /// way it was, and "the way it was" includes where the camera sat, how far it
  /// had expanded, and whether it was there at all.
  slot_webcam: Vec<StagedWebcam>,

  /// The cursor image, and where it sits in each staged slot.
  ///
  /// The position depends on the frame's timestamp, so it is resolved once at
  /// stage time and remembered -- a re-render must put the cursor back exactly
  /// where it was, not where the playhead has since moved to.
  cursor: Option<SpriteTexture>,
  /// The per-sample bitmaps. Empty means every sample draws `cursor`.
  cursor_images: CursorImages,
  cursor_track: CursorTrack,
  cursor_size: f32,
  cursor_opacity: f32,
  cursor_effects: CursorEffects,
  slot_cursor: Vec<Option<StagedCursor>>,

  /// The zoom timeline, and where each staged slot sat on it.
  ///
  /// Remembered per slot for the same reason the cursor rect is: a re-render
  /// -- a grading change, a webcam move -- has to put the frame back at the
  /// zoom *it* had, not the zoom the playhead has since moved to.
  zoom_track: ZoomTrack,
  slot_zoom: Vec<ZoomState>,

  overlays: Overlays,

  /// Chain output in BGRA, for consumers without their own destination. The
  /// exporter reads it through the NV12 passes; preview skips it entirely and
  /// renders straight into a shared pool slot.
  #[allow(dead_code)]
  output: ID3D11Texture2D,
  output_rtv: ID3D11RenderTargetView,
  output_srv: ID3D11ShaderResourceView,

  /// NV12 form of the output, for the encoder. The plane views are chosen by
  /// format: R8 is plane 0 (Y), R8G8 is plane 1 (interleaved CbCr, half size).
  nv12_out: ID3D11Texture2D,
  rtv_y: ID3D11RenderTargetView,
  rtv_uv: ID3D11RenderTargetView,

  /// The video layer's grade, and the webcam's. Per-layer because they are two
  /// different sensors with two different exposures; the cursor has none
  /// because it is a bitmap of a pointer.
  params: EffectParams,
  webcam_params: EffectParams,
}

impl RenderChain {
  /// `coded` is the decoder's frame size, which is what the textures are
  /// allocated at. `display` is the visible sub-rectangle inside it -- equal to
  /// `coded` on most files, smaller on anything H.264 padded to macroblock
  /// alignment (a 1080-tall recording is usually coded at 1088).
  ///
  /// `canvas` is what the chain outputs. Pass the source's display size for a
  /// project with no background, or the project's canvas size for one with --
  /// the video is then inset into it by `set_layout`.
  ///
  /// `slots` is how many decoded frames the chain can hold at once. The player
  /// passes its pool size; the exporter only ever needs one.
  pub fn new(
    coded: (u32, u32),
    display: (u32, u32),
    canvas: (u32, u32),
    slots: usize,
  ) -> Result<Self> {
    let (source_width, source_height) = coded;
    // A file that reports no aperture, or a nonsense one, gets the coded size:
    // being wrong by the padding beats rendering into a zero-sized target.
    let display_width = if display.0 == 0 || display.0 > source_width {
      source_width
    } else {
      display.0
    };
    let display_height = if display.1 == 0 || display.1 > source_height {
      source_height
    } else {
      display.1
    };
    // NV12 output needs even dimensions, and a zero-sized target is not a
    // recoverable state, so the canvas is forced into something renderable here
    // rather than trusted.
    let canvas_width = if canvas.0 < 2 {
      display_width
    } else {
      canvas.0
    } & !1;
    let canvas_height = if canvas.1 < 2 {
      display_height
    } else {
      canvas.1
    } & !1;
    let gpu = gpu()?;

    let vs_blob = compile(HLSL, "vs_fullscreen", "vs_5_0")?;
    let convert_blob = compile(HLSL, "ps_nv12_to_bgra", "ps_5_0")?;
    let to_y_blob = compile(HLSL, "ps_bgra_to_y", "ps_5_0")?;
    let to_uv_blob = compile(HLSL, "ps_bgra_to_uv", "ps_5_0")?;
    let quad_blob = compile(HLSL, "vs_quad", "vs_5_0")?;
    let overlay_blob = compile(HLSL, "ps_overlay", "ps_5_0")?;
    let sprite_blob = compile(HLSL, "ps_sprite", "ps_5_0")?;
    let smear_blob = compile(HLSL, "ps_smear", "ps_5_0")?;
    let solid_blob = compile(HLSL, "ps_solid", "ps_5_0")?;
    let shadow_blob = compile(HLSL, "ps_shadow", "ps_5_0")?;

    let mut vs = None;
    let mut ps_convert = None;
    let mut ps_to_y = None;
    let mut ps_to_uv = None;
    unsafe {
      gpu
        .device
        .CreateVertexShader(blob(&vs_blob), None, Some(&mut vs))?;
      gpu
        .device
        .CreatePixelShader(blob(&convert_blob), None, Some(&mut ps_convert))?;
      gpu
        .device
        .CreatePixelShader(blob(&to_y_blob), None, Some(&mut ps_to_y))?;
      gpu
        .device
        .CreatePixelShader(blob(&to_uv_blob), None, Some(&mut ps_to_uv))?;
    }

    // Linear sampling is what upsamples the half-resolution chroma plane.
    let sampler_desc = D3D11_SAMPLER_DESC {
      Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
      AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
      AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
      AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
      ComparisonFunc: D3D11_COMPARISON_NEVER,
      MaxLOD: f32::MAX,
      ..Default::default()
    };
    let mut sampler = None;
    unsafe {
      gpu
        .device
        .CreateSamplerState(&sampler_desc, Some(&mut sampler))?
    };

    let mut vs_quad = None;
    let mut ps_overlay = None;
    let mut ps_sprite = None;
    let mut ps_smear = None;
    let mut ps_solid = None;
    let mut ps_shadow = None;
    unsafe {
      gpu
        .device
        .CreateVertexShader(blob(&quad_blob), None, Some(&mut vs_quad))?;
      gpu
        .device
        .CreatePixelShader(blob(&overlay_blob), None, Some(&mut ps_overlay))?;
      gpu
        .device
        .CreatePixelShader(blob(&sprite_blob), None, Some(&mut ps_sprite))?;
      gpu
        .device
        .CreatePixelShader(blob(&smear_blob), None, Some(&mut ps_smear))?;
      gpu
        .device
        .CreatePixelShader(blob(&solid_blob), None, Some(&mut ps_solid))?;
      gpu
        .device
        .CreatePixelShader(blob(&shadow_blob), None, Some(&mut ps_shadow))?;
    }

    let overlays = Overlays::new(
      gpu,
      vs_quad.expect("quad vertex shader"),
      ps_overlay.expect("overlay shader"),
      ps_sprite.expect("sprite shader"),
      ps_smear.expect("smear shader"),
      ps_solid.expect("solid shader"),
      ps_shadow.expect("shadow shader"),
    )?;

    // Three effect floats plus a texel size, padded to a 16-byte multiple.
    let constants = create_constant_buffer(gpu, 32)?;

    let mut sources = Vec::with_capacity(slots.max(1));
    for _ in 0..slots.max(1) {
      let texture = create_texture(
        gpu,
        source_width,
        source_height,
        DXGI_FORMAT_NV12,
        D3D11_BIND_SHADER_RESOURCE.0 as u32,
      )?;
      let srv_y = create_srv(gpu, &texture, DXGI_FORMAT_R8_UNORM)?;
      let srv_uv = create_srv(gpu, &texture, DXGI_FORMAT_R8G8_UNORM)?;
      sources.push(Source {
        texture,
        srv_y,
        srv_uv,
      });
    }

    let bgra_bind = (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32;

    // At the source's size, not the canvas's: this is the decoded picture before
    // anything decides where on the canvas it goes.
    let video_bgra = create_texture(
      gpu,
      source_width,
      source_height,
      DXGI_FORMAT_B8G8R8A8_UNORM,
      bgra_bind,
    )?;
    let video_bgra_rtv = create_rtv(gpu, &video_bgra)?;
    let video_bgra_srv = create_srv(gpu, &video_bgra, DXGI_FORMAT_B8G8R8A8_UNORM)?;

    let output = create_texture(
      gpu,
      canvas_width,
      canvas_height,
      DXGI_FORMAT_B8G8R8A8_UNORM,
      bgra_bind,
    )?;
    let output_rtv = create_rtv(gpu, &output)?;
    let output_srv = create_srv(gpu, &output, DXGI_FORMAT_B8G8R8A8_UNORM)?;

    // The canvas is already even, and the source's macroblock padding was left
    // behind by the video quad's UVs long before this point.
    let nv12_out = create_texture(
      gpu,
      canvas_width,
      canvas_height,
      DXGI_FORMAT_NV12,
      bgra_bind,
    )?;
    let rtv_y = create_planar_rtv(gpu, &nv12_out, DXGI_FORMAT_R8_UNORM)?;
    let rtv_uv = create_planar_rtv(gpu, &nv12_out, DXGI_FORMAT_R8G8_UNORM)?;

    Ok(Self {
      source_width,
      source_height,
      display_width,
      display_height,
      canvas_width,
      canvas_height,
      vs: vs.expect("vertex shader"),
      ps_convert: ps_convert.expect("convert shader"),
      ps_to_y: ps_to_y.expect("to-y shader"),
      ps_to_uv: ps_to_uv.expect("to-uv shader"),
      sampler: sampler.expect("sampler"),
      constants,
      sources,
      video_bgra,
      video_bgra_rtv,
      video_bgra_srv,
      layout: VideoLayout::covering(canvas_width, canvas_height),
      background: Background::default(),
      crop: None,
      output,
      output_rtv,
      output_srv,
      nv12_out,
      rtv_y,
      rtv_uv,
      params: EffectParams::default(),
      webcam_params: EffectParams::default(),
      webcam: None,
      webcam_layout: WebcamLayout::default(),
      webcam_hidden: HiddenSpans::default(),
      layer_order: DEFAULT_LAYER_ORDER,
      webcam_zoom: WebcamZoomTrack::default(),
      slot_webcam: vec![StagedWebcam::default(); slots.max(1)],
      cursor: None,
      cursor_images: CursorImages::default(),
      cursor_track: CursorTrack::default(),
      cursor_size: DEFAULT_CURSOR_SIZE_PX,
      cursor_opacity: 1.0,
      cursor_effects: CursorEffects::default(),
      slot_cursor: vec![None; slots.max(1)],
      zoom_track: ZoomTrack::default(),
      slot_zoom: vec![ZoomState::default(); slots.max(1)],
      overlays,
    })
  }

  /// Size of the frame the encoder receives from `process_to_nv12`.
  ///
  /// The canvas, which is not necessarily what the caller asked to open -- so
  /// the encoder has to be created from this rather than from the decoder, or
  /// the sink writer gets a size its input does not match.
  pub fn output_size(&self) -> (u32, u32) {
    (self.canvas_width, self.canvas_height)
  }

  /// Place the recording on the canvas.
  ///
  /// Pixel coordinates, resolved by the caller: the padding fraction, the scale
  /// and the centring live on the JS side alongside the webcam's anchor grid,
  /// so there is one layout formula in the app.
  pub fn set_layout(&mut self, layout: VideoLayout) {
    self.layout = layout.sanitized();
  }

  /// What fills the canvas behind the video. Only visible once something insets
  /// the video, so this costs nothing on a project with no background.
  pub fn set_background(&mut self, background: Background) {
    self.background = background;
  }

  /// The webcam's own grade, separate from the video's.
  pub fn set_webcam_params(&mut self, params: EffectParams) {
    self.webcam_params = params;
  }

  /// Throw away the edges of the recording.
  ///
  /// This does not resize anything: the kept region is stretched across
  /// whatever rect `set_layout` was given. Cropping to a different aspect ratio
  /// and keeping the old rect will distort, so the caller sizes the rect from
  /// the cropped dimensions -- the same division of labour as the webcam's box.
  pub fn set_source_crop(&mut self, crop: Option<SourceCrop>) {
    self.crop = crop.and_then(SourceCrop::resolve);
  }

  /// Which part of the video's own texture is real picture.
  ///
  /// The macroblock padding is cropped here, on the quad that places the video,
  /// rather than on the way to the encoder -- so preview and export leave the
  /// same rows behind.
  fn video_uv(&self) -> UvRect {
    // The visible picture occupies the top-left of the coded texture, so this
    // is where it ends.
    let visible = [
      self.display_width as f32 / self.source_width.max(1) as f32,
      self.display_height as f32 / self.source_height.max(1) as f32,
    ];

    let Some(crop) = self.crop else {
      return UvRect {
        scale: visible,
        offset: [0.0, 0.0],
      };
    };

    // The crop is a fraction of the *visible* frame, not of the texture, so it
    // composes with the padding rather than replacing it.
    UvRect {
      scale: [crop.width() * visible[0], crop.height() * visible[1]],
      offset: [crop.left * visible[0], crop.top * visible[1]],
    }
  }

  /// Attach a webcam layer at the camera's own resolution.
  ///
  /// Separate from `new` because the webcam is optional and its size is not
  /// known until its decoder is open, which happens after the chain exists.
  pub fn attach_webcam(&mut self, width: u32, height: u32) -> Result<()> {
    let gpu = gpu()?;
    let slots = self.sources.len();

    let mut sources = Vec::with_capacity(slots);
    for _ in 0..slots {
      let texture = create_texture(
        gpu,
        width,
        height,
        DXGI_FORMAT_NV12,
        D3D11_BIND_SHADER_RESOURCE.0 as u32,
      )?;
      let srv_y = create_srv(gpu, &texture, DXGI_FORMAT_R8_UNORM)?;
      let srv_uv = create_srv(gpu, &texture, DXGI_FORMAT_R8G8_UNORM)?;
      sources.push(Source {
        texture,
        srv_y,
        srv_uv,
      });
    }

    let bgra = create_texture(
      gpu,
      width,
      height,
      DXGI_FORMAT_B8G8R8A8_UNORM,
      (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
    )?;
    let bgra_rtv = create_rtv(gpu, &bgra)?;
    let bgra_srv = create_srv(gpu, &bgra, DXGI_FORMAT_B8G8R8A8_UNORM)?;

    self.webcam = Some(WebcamLayer {
      width,
      height,
      sources,
      staged: vec![false; slots],
      bgra,
      bgra_rtv,
      bgra_srv,
    });

    Ok(())
  }

  /// Which of the three drawable layers sits on top of which, bottom first.
  pub fn set_layer_order(&mut self, order: [Layer; 3]) {
    self.layer_order = order;
  }

  /// Spans where the camera changes size, or expands to the whole frame.
  pub fn set_webcam_zoom_regions(&mut self, track: WebcamZoomTrack) {
    self.webcam_zoom = track;
  }

  /// Spans of the composition to leave the camera out of.
  ///
  /// Already in composition time: a span cut from the screen as well is gone
  /// from the timeline entirely and collapses to nothing before it gets here,
  /// so what arrives is only the spans where the recording keeps playing
  /// without the camera in it.
  pub fn set_webcam_cuts(&mut self, spans: Vec<(f64, f64)>) {
    self.webcam_hidden = HiddenSpans::new(spans);
  }

  pub fn set_webcam_layout(&mut self, layout: WebcamLayout) {
    // Sanitised here rather than at the napi boundary so every caller gets it,
    // the exporter included.
    self.webcam_layout = layout.sanitized();
  }

  /// Copy a decoded webcam frame into a slot.
  ///
  /// Slots without one keep whatever they had; the caller decides whether that
  /// is the right frame, because holding the previous camera image is correct
  /// when the camera is slower than the screen and wrong after a seek.
  pub fn stage_webcam(
    &mut self,
    slot: usize,
    src: &ID3D11Texture2D,
    subresource: u32,
  ) -> Result<()> {
    let _guard = crate::engine::d3d::render_lock();
    self.stage_webcam_locked(slot, src, subresource)
  }

  pub(crate) fn stage_webcam_locked(
    &mut self,
    slot: usize,
    src: &ID3D11Texture2D,
    subresource: u32,
  ) -> Result<()> {
    let Some(webcam) = self.webcam.as_mut() else {
      return Ok(());
    };

    let index = slot % webcam.sources.len();
    let gpu = gpu()?;
    unsafe {
      gpu.context.CopySubresourceRegion(
        &webcam.sources[index].texture,
        0,
        0,
        0,
        0,
        src,
        subresource,
        None,
      );
    }
    webcam.staged[index] = true;

    Ok(())
  }

  /// Carry a slot's webcam frame forward into the next slot.
  ///
  /// The camera is usually slower than the screen capture -- and screen capture
  /// only ticks when something changes, so the ratio is not fixed -- which means
  /// most frames have no new camera image. Inheriting keeps the last one on
  /// screen instead of the slot showing whatever it held several cycles ago.
  pub fn inherit_webcam(&mut self, from: usize, to: usize) -> Result<()> {
    let _guard = crate::engine::d3d::render_lock();
    self.inherit_webcam_locked(from, to)
  }

  pub(crate) fn inherit_webcam_locked(&mut self, from: usize, to: usize) -> Result<()> {
    let Some(webcam) = self.webcam.as_mut() else {
      return Ok(());
    };

    let slots = webcam.sources.len();
    let (from, to) = (from % slots, to % slots);
    if from == to || !webcam.staged[from] {
      return Ok(());
    }

    let gpu = gpu()?;
    unsafe {
      gpu
        .context
        .CopyResource(&webcam.sources[to].texture, &webcam.sources[from].texture);
    }
    webcam.staged[to] = true;

    Ok(())
  }

  /// Forget every staged webcam frame.
  ///
  /// A seek makes them all wrong: holding a stale camera image over the new
  /// position is worse than showing none.
  pub fn clear_webcam_staging(&mut self) {
    if let Some(webcam) = self.webcam.as_mut() {
      webcam.staged.iter_mut().for_each(|staged| *staged = false);
    }
  }

  pub fn set_cursor_images(&mut self, images: CursorImages) {
    self.cursor_images = images;
  }

  pub fn set_cursor_image(&mut self, sprite: Option<SpriteTexture>) {
    self.cursor = sprite;
  }

  pub fn set_cursor_track(&mut self, track: CursorTrack) {
    self.cursor_track = track;
  }

  /// Set the zoom/pan timeline.
  pub fn set_zoom_track(&mut self, track: ZoomTrack) {
    self.zoom_track = track;
  }

  pub fn set_cursor_style(&mut self, size: f32, opacity: f32) {
    self.cursor_size = size.max(0.0);
    self.cursor_opacity = opacity.clamp(0.0, 1.0);
  }

  pub fn set_cursor_effects(&mut self, effects: CursorEffects) {
    self.cursor_effects = CursorEffects {
      click_scale: effects.click_scale.max(0.0),
      click_duration_ms: effects.click_duration_ms.max(0.0),
      smear_strength: effects.smear_strength.max(0.0),
    };
  }

  /// Resolve everything that depends on *this frame's* timestamp, and remember
  /// it against the slot: where the cursor sits, and how far the zoom is in.
  ///
  /// Done at stage time rather than render time so a later re-render -- a
  /// grading change, a webcam move -- puts the frame back the way it was
  /// instead of the way the playhead is now. Getting this wrong is subtle: the
  /// preview looks right until you drag a slider, and then every queued frame
  /// snaps to the playhead's zoom.
  pub fn stage_timeline(&mut self, slot: usize, timestamp_ms: f64) {
    let index = slot % self.slot_cursor.len();
    // Against the unzoomed video rect: the zoom is applied to the resolved
    // rectangle at draw time, exactly as the compositor draws the cursor inside
    // the zoom transform rather than pre-multiplying its position.
    self.slot_cursor[index] = self.resolve_cursor_rect(timestamp_ms);
    self.slot_zoom[index] = self.zoom_track.state_at(timestamp_ms, self.layout.rect);
    let webcam_index = slot % self.slot_webcam.len();
    let webcam_zoom = self.webcam_zoom.state_at(timestamp_ms, self.webcam_layout.rect);
    self.slot_webcam[webcam_index] = StagedWebcam {
      visible: !self.webcam_hidden.contains(timestamp_ms),
      rect: webcam_zoom.rect,
      full_screen: webcam_zoom.full_screen,
    };
  }

  /// The bitmap a sample should be drawn with: its own, or the default.
  ///
  /// An id the table does not have falls through to the default rather than
  /// hiding the pointer -- a missing image should look wrong, not absent.
  fn sprite_for(&self, image_id: Option<u32>) -> Option<&SpriteTexture> {
    image_id
      .and_then(|id| self.cursor_images.get(id))
      .or(self.cursor.as_ref())
  }

  fn resolve_cursor_rect(&self, timestamp_ms: f64) -> Option<StagedCursor> {
    if self.cursor_opacity <= 0.0 || self.cursor_size <= 0.0 {
      return None;
    }

    let sample = self.cursor_track.sample_at(timestamp_ms)?;
    let sprite = self.sprite_for(sample.image_id)?;

    // Cursor positions are recorded against the whole frame, so a crop moves
    // them: what was 50% across an uncropped frame is further right once the
    // left edge is gone. A pointer that lands outside the kept region is not
    // drawn at all, rather than clamped to the edge -- it genuinely is not on
    // screen any more.
    let (sample_x, sample_y) = match self.crop {
      None => (sample.x, sample.y),
      Some(crop) => {
        let x = (sample.x - crop.left) / crop.width();
        let y = (sample.y - crop.top) / crop.height();
        if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
          return None;
        }
        (x, y)
      }
    };

    // The image keeps its aspect ratio; `cursor_size` is its height. A click
    // rides on the same scale, which is what keeps the pop anchored: the rect
    // is positioned by subtracting the scaled hotspot, so growing the scale
    // grows the pointer *about its own tip* rather than about a corner.
    let click = self.cursor_track.click_scale_at(
      timestamp_ms,
      self.cursor_effects.click_scale,
      self.cursor_effects.click_duration_ms,
    );
    let scale = (self.cursor_size / sprite.height.max(1) as f32) * click;
    let width = sprite.width as f32 * scale;
    let height = sprite.height as f32 * scale;

    // Normalised position is the cursor's *point*, so the image is offset by
    // its hotspot. Skipping this puts an arrow's tip below and right of the
    // place the user actually clicked.
    // Against the video's rect on the canvas, not the canvas and not the coded
    // frame. The track's positions are a fraction of the picture the user saw,
    // so they follow the video when it is inset, scaled or moved -- and the
    // macroblock padding was never part of that picture either.
    let video = self.layout.rect;
    Some(StagedCursor {
      rect: Rect {
        x: video.x + sample_x * video.width - sprite.hotspot_x * scale,
        y: video.y + sample_y * video.height - sprite.hotspot_y * scale,
        width,
        height,
      },
      image_id: sample.image_id,
      smear: self.resolve_smear(timestamp_ms, video, height),
    })
  }

  /// How far the pointer's tail reaches at this instant, in canvas pixels.
  ///
  /// The vector points the way the pointer is *going*; the tail is drawn behind
  /// it. Length is how far it would travel in `SMEAR_TRAVEL_MS`, so the smear
  /// grows and shrinks with real speed rather than being a fixed decoration --
  /// then capped, because speed has no upper bound and a smear does.
  fn resolve_smear(&self, timestamp_ms: f64, video: Rect, height: f32) -> [f32; 2] {
    let strength = self.cursor_effects.smear_strength;
    if strength <= 0.0 || height <= 0.0 {
      return [0.0, 0.0];
    }

    let Some(motion) = self.cursor_track.motion_at(timestamp_ms) else {
      return [0.0, 0.0];
    };

    // Normalised units per millisecond into canvas pixels per millisecond. The
    // two axes scale differently on a non-square video, which is the point:
    // moving across a 16:9 frame covers more pixels than moving down it.
    let vx = motion.vx * video.width;
    let vy = motion.vy * video.height;
    let speed = (vx * vx + vy * vy).sqrt();
    if speed <= 0.0 {
      return [0.0, 0.0];
    }

    let length = (speed * SMEAR_TRAVEL_MS * strength).min(height * MAX_SMEAR_HEIGHTS);
    if length < height * MIN_SMEAR_HEIGHTS {
      return [0.0, 0.0];
    }

    [vx / speed * length, vy / speed * length]
  }

  pub fn set_params(&mut self, params: EffectParams) {
    self.params = params;
  }

  /// Copy a decoded frame into a slot's own NV12 texture. Source-sized, like
  /// the textures it lands in.
  ///
  /// Separate from rendering so the same pixels can be rendered again later
  /// under different settings without touching the decoder.
  pub fn stage(&self, slot: usize, src: &ID3D11Texture2D, subresource: u32) -> Result<()> {
    let _guard = crate::engine::d3d::render_lock();
    self.stage_locked(slot, src, subresource)
  }

  /// Render a staged slot into a destination. Safe to call repeatedly, which is
  /// the whole point: changing a filter re-runs this, not the decoder.
  pub fn render_slot(&self, slot: usize, dst_rtv: &ID3D11RenderTargetView) -> Result<()> {
    let _guard = crate::engine::d3d::render_lock();
    self.render_locked(slot, dst_rtv)
  }

  /// Stage and render under one lock -- the normal decode path.
  pub fn process(
    &self,
    slot: usize,
    src: &ID3D11Texture2D,
    subresource: u32,
    dst_rtv: &ID3D11RenderTargetView,
  ) -> Result<()> {
    let _guard = crate::engine::d3d::render_lock();
    self.stage_locked(slot, src, subresource)?;
    self.render_locked(slot, dst_rtv)
  }

  /// Run the chain, then convert the result to NV12 for the encoder.
  ///
  /// Two extra passes rather than letting the sink writer insert its own
  /// converter: the implicit RGB32 input path fails with E_INVALIDARG on the
  /// second frame, and owning both directions keeps one colour matrix across
  /// the round trip.
  pub fn process_to_nv12(
    &self,
    src: &ID3D11Texture2D,
    subresource: u32,
  ) -> Result<&ID3D11Texture2D> {
    // One acquisition for all five passes: a half-converted frame would be
    // worse than waiting.
    let _guard = crate::engine::d3d::render_lock();

    self.stage_locked(0, src, subresource)?;
    let output_rtv = self.output_rtv.clone();
    self.render_locked(0, &output_rtv)?;

    let gpu = gpu()?;
    let ctx = &gpu.context;

    let (out_width, out_height) = self.output_size();

    unsafe {
      // Straight through: the chain output is already the canvas, and the
      // source's macroblock padding was cropped by the video quad.
      self.upload_params(ctx)?;
      ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
      ctx.IASetInputLayout(None);
      ctx.VSSetShader(&self.vs, None);
      ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
      ctx.PSSetConstantBuffers(0, Some(&[Some(self.constants.clone())]));
      ctx.PSSetShaderResources(0, Some(&[Some(self.output_srv.clone())]));

      // Luma at full resolution into plane 0.
      set_viewport(ctx, out_width, out_height);
      ctx.OMSetRenderTargets(Some(&[Some(self.rtv_y.clone())]), None);
      ctx.PSSetShader(&self.ps_to_y, None);
      ctx.Draw(3, 0);

      // Chroma at half resolution into plane 1. This is where the 4:2:0
      // subsampling actually happens.
      set_viewport(ctx, out_width / 2, out_height / 2);
      ctx.OMSetRenderTargets(Some(&[Some(self.rtv_uv.clone())]), None);
      ctx.PSSetShader(&self.ps_to_uv, None);
      ctx.Draw(3, 0);

      ctx.PSSetShaderResources(0, Some(&[None]));
      ctx.OMSetRenderTargets(Some(&[None]), None);
      ctx.Flush();
    }

    Ok(&self.nv12_out)
  }

  fn stage_locked(&self, slot: usize, src: &ID3D11Texture2D, subresource: u32) -> Result<()> {
    let gpu = gpu()?;
    let target = &self.sources[slot % self.sources.len()].texture;
    unsafe {
      gpu
        .context
        .CopySubresourceRegion(target, 0, 0, 0, 0, src, subresource, None);
    }
    Ok(())
  }

  /// Compose one slot onto the canvas.
  ///
  /// Every layer is a quad now, including the video. That is what lets the
  /// canvas be bigger than the recording: the video is placed into a rectangle
  /// rather than being the frame, so there is somewhere for a background to be
  /// and something for a border to go around. It also means the grade is
  /// per-layer, because each quad carries its own.
  ///
  /// ```text
  ///   background  ClearRenderTargetView, then an optional image quad
  ///   video       NV12 -> BGRA at source size, then a quad into the video rect
  ///   webcam      NV12 -> BGRA at camera size, then a quad into its box
  ///   cursor      a sprite, alpha from the image
  /// ```
  fn render_locked(&self, slot: usize, dst_rtv: &ID3D11RenderTargetView) -> Result<()> {
    let gpu = gpu()?;
    let ctx = &gpu.context;
    let source = &self.sources[slot % self.sources.len()];

    unsafe {
      ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
      // No vertex or index buffers: the VS builds the triangle from SV_VertexID.
      ctx.IASetInputLayout(None);
      ctx.VSSetShader(&self.vs, None);
      ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));

      // ---- background -----------------------------------------------------
      //
      // A clear rather than a shader. It has to happen unconditionally even for
      // an opaque full-canvas video: the destination is a pool slot that held a
      // different frame a moment ago, and anything the video does not cover
      // would still be showing it.
      ctx.ClearRenderTargetView(dst_rtv, &self.background.clear_colour());

      // ---- video: NV12 -> BGRA, at the source's own resolution -------------
      set_viewport(ctx, self.source_width, self.source_height);
      ctx.OMSetRenderTargets(Some(&[Some(self.video_bgra_rtv.clone())]), None);
      ctx.PSSetShader(&self.ps_convert, None);
      ctx.PSSetShaderResources(
        0,
        Some(&[Some(source.srv_y.clone()), Some(source.srv_uv.clone())]),
      );
      ctx.Draw(3, 0);

      // Unbind before it is read as a source, or D3D11 silently drops one of
      // the two bindings.
      ctx.PSSetShaderResources(0, Some(&[None, None]));
      ctx.OMSetRenderTargets(Some(&[None]), None);

      // ---- everything else is a quad on the canvas -------------------------
      set_viewport(ctx, self.canvas_width, self.canvas_height);

      if let Background::Image { texture, .. } = &self.background {
        self.draw_quad_locked(
          ctx,
          dst_rtv,
          &texture.srv,
          Quad {
            rect: Rect::covering(self.canvas_width, self.canvas_height),
            shape: OverlayShape::Rect,
            corner_radius: 0.0,
            opacity: 1.0,
            uv: UvRect::default(),
            grade: Grade::default(),
            fill: Fill::Texture,
          },
        )?;
      }

      // The zoom this frame was staged at, not the playhead's.
      let zoom = self.slot_zoom[slot % self.slot_zoom.len()];

      for layer in self.layer_order {
        match layer {
          Layer::Video => self.composite_video_locked(ctx, dst_rtv, zoom)?,
          // The webcam is deliberately not zoomed: a zoom is about the
          // recording, and the camera box is furniture on top of it. Same split
          // the compositor makes with its `base` and `zoomed` layer spaces.
          Layer::Webcam => self.composite_webcam_locked(ctx, slot, dst_rtv)?,
          Layer::Cursor => self.composite_cursor_locked(ctx, slot, dst_rtv, zoom)?,
        }
      }

      // Leave nothing bound: a slot's source becomes a copy destination again on
      // a later frame, and D3D11 refuses that while it is still an SRV.
      ctx.PSSetShaderResources(0, Some(&[None, None]));
      ctx.OMSetRenderTargets(Some(&[None]), None);
      ctx.Flush();
    }

    Ok(())
  }

  /// One overlay draw, with the viewport already set to the canvas.
  unsafe fn draw_quad_locked(
    &self,
    ctx: &ID3D11DeviceContext,
    dst_rtv: &ID3D11RenderTargetView,
    source: &ID3D11ShaderResourceView,
    quad: Quad,
  ) -> Result<()> {
    self.overlays.draw(
      ctx,
      dst_rtv,
      source,
      self.canvas_width,
      self.canvas_height,
      quad,
    )
  }

  /// Place the converted video on the canvas, with its border under it.
  unsafe fn composite_video_locked(
    &self,
    ctx: &ID3D11DeviceContext,
    dst_rtv: &ID3D11RenderTargetView,
    zoom: ZoomState,
  ) -> Result<()> {
    let layout = self.layout;
    if layout.rect.is_empty() {
      return Ok(());
    }

    // The zoom scales the rect about its pivot, and the radius and border with
    // it -- under a canvas transform they would scale too, and a border that
    // stayed 4px while the video doubled would read as a bug.
    let rect = zoom.apply(layout.rect);
    let corner_radius = layout.corner_radius * zoom.scale;
    let border_width = layout.border_width * zoom.scale;

    unsafe {
      // The border is the same rounded rect grown by its width and filled, drawn
      // first so the video lands on top of it. Its radius grows too, or the
      // corners of the border and the corners of the video would not be
      // concentric.
      if border_width > 0.0 {
        self.draw_quad_locked(
          ctx,
          dst_rtv,
          &self.video_bgra_srv,
          Quad {
            rect: rect.expanded(border_width),
            shape: OverlayShape::Rect,
            corner_radius: corner_radius + border_width,
            opacity: 1.0,
            uv: UvRect::default(),
            grade: Grade::default(),
            fill: Fill::Solid(layout.border_colour),
          },
        )?;
      }

      self.draw_quad_locked(
        ctx,
        dst_rtv,
        &self.video_bgra_srv,
        Quad {
          rect,
          shape: OverlayShape::Rect,
          corner_radius,
          opacity: 1.0,
          uv: self.video_uv(),
          grade: self.params.into(),
          fill: Fill::Texture,
        },
      )?;
    }

    Ok(())
  }

  /// Convert this slot's webcam frame to BGRA and blend it into the destination.
  ///
  /// Two passes: the camera is NV12 at its own resolution, so it converts into
  /// its own scratch target first and is then drawn as a quad. Skipped entirely
  /// when there is no webcam, no frame staged for this slot, or the box has been
  /// sized to nothing -- an invisible layer should cost nothing.
  unsafe fn composite_webcam_locked(
    &self,
    ctx: &ID3D11DeviceContext,
    slot: usize,
    dst_rtv: &ID3D11RenderTargetView,
  ) -> Result<()> {
    let Some(webcam) = self.webcam.as_ref() else {
      return Ok(());
    };
    if !self.webcam_layout.is_visible() {
      return Ok(());
    }
    // The camera as this frame had it, not as the playhead has it now.
    let staged = self.slot_webcam[slot % self.slot_webcam.len()];
    if !staged.visible {
      return Ok(());
    }

    let index = slot % webcam.sources.len();
    if !webcam.staged[index] {
      return Ok(());
    }

    let source = &webcam.sources[index];

    // Expanding to the whole canvas dissolves everything that made it a box:
    // the corner radius, the border, and the shape itself all go, and the
    // opacity rises to solid. Blended rather than switched, so a camera easing
    // out to full screen does not pop its rounded corners off partway.
    let expansion = staged.full_screen.clamp(0.0, 1.0);
    let softened = 1.0 - expansion;
    let box_rect = if expansion > 0.0 {
      lerp_rect(staged.rect, Rect::covering(self.canvas_width, self.canvas_height), expansion)
    } else {
      staged.rect
    };
    let shape = if expansion > 0.0 {
      OverlayShape::Rect
    } else {
      self.webcam_layout.shape
    };
    let corner_radius = self.webcam_layout.corner_radius * softened;
    let border_width = self.webcam_layout.border_width * softened;
    let opacity = self.webcam_layout.opacity + (1.0 - self.webcam_layout.opacity) * expansion;

    // The camera almost never matches the box the caller asked for, and a
    // stretched face is more obviously wrong than a cropped one. Resolved here
    // because this is the only place that knows the camera's real resolution.
    let (rect, uv) = fit_source(box_rect, webcam.width, webcam.height, self.webcam_layout.fit);

    unsafe {
      // Pass 1: NV12 -> BGRA, at the camera's resolution.
      set_viewport(ctx, webcam.width, webcam.height);
      ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
      ctx.IASetInputLayout(None);
      ctx.VSSetShader(&self.vs, None);
      ctx.OMSetRenderTargets(Some(&[Some(webcam.bgra_rtv.clone())]), None);
      ctx.PSSetShader(&self.ps_convert, None);
      ctx.PSSetShaderResources(
        0,
        Some(&[Some(source.srv_y.clone()), Some(source.srv_uv.clone())]),
      );
      ctx.Draw(3, 0);

      ctx.PSSetShaderResources(0, Some(&[None, None]));
      ctx.OMSetRenderTargets(Some(&[None]), None);

      // Pass 2: blend it into the frame, back at canvas resolution.
      set_viewport(ctx, self.canvas_width, self.canvas_height);

      // Shadows first, under everything. Cast by the camera's own rectangle
      // rather than the bordered one, matching the Canvas2D compositor: it
      // fills the shape and draws the border *outside* it, so a thick border
      // sits on top of the shadow's inner edge. Worth knowing, because it is
      // the one place where a shadow does not look the way a CSS one would.
      for shadow in &self.webcam_layout.shadows {
        // Faded out with the corner radius and the border as the camera fills
        // the frame -- a shadow cast by something the size of the canvas has
        // nowhere to land. The compositor cuts them at 85% instead, which pops.
        let colour = [
          shadow.colour[0],
          shadow.colour[1],
          shadow.colour[2],
          shadow.colour[3] * softened,
        ];
        if colour[3] <= 0.0 {
          continue;
        }

        self.draw_quad_locked(
          ctx,
          dst_rtv,
          &webcam.bgra_srv,
          Quad {
            rect: shadow.quad_rect(rect),
            shape,
            corner_radius,
            opacity,
            uv: UvRect::default(),
            grade: Grade::default(),
            fill: Fill::Shadow(ShadowFill {
              colour,
              half: [rect.width * 0.5, rect.height * 0.5],
              softness: shadow.softness(),
            }),
          },
        )?;
      }

      // Border next, under the camera, same as the video layer.
      if border_width > 0.0 {
        self.draw_quad_locked(
          ctx,
          dst_rtv,
          &webcam.bgra_srv,
          Quad {
            rect: rect.expanded(border_width),
            shape,
            corner_radius: corner_radius + border_width,
            opacity,
            uv: UvRect::default(),
            grade: Grade::default(),
            fill: Fill::Solid(self.webcam_layout.border_colour),
          },
        )?;
      }

      self.draw_quad_locked(
        ctx,
        dst_rtv,
        &webcam.bgra_srv,
        Quad {
          rect,
          shape,
          corner_radius,
          opacity,
          uv,
          grade: self.webcam_params.into(),
          fill: Fill::Texture,
        },
      )?;
    }

    Ok(())
  }

  /// Draw the cursor where this slot's frame had it.
  unsafe fn composite_cursor_locked(
    &self,
    ctx: &ID3D11DeviceContext,
    slot: usize,
    dst_rtv: &ID3D11RenderTargetView,
    zoom: ZoomState,
  ) -> Result<()> {
    let Some(staged) = self.slot_cursor[slot % self.slot_cursor.len()] else {
      return Ok(());
    };
    // The one staged with the frame, not the one the track would pick now: a
    // re-render after a grading change must not swap the pointer's shape.
    let Some(sprite) = self.sprite_for(staged.image_id) else {
      return Ok(());
    };
    let rect = staged.rect;

    // In zoomed space with the video, so it grows and moves with it -- the
    // compositor draws the cursor inside the same transform. The smear is a
    // distance in the same pixels, so it takes the same scale; without that,
    // zooming in would leave the tail the length it was at 1x.
    let rect = zoom.apply(rect);
    let smear = [staged.smear[0] * zoom.scale, staged.smear[1] * zoom.scale];

    // The pointer's own rect and the whole of it, which differ only when there
    // is a tail to leave room for.
    let (quad_rect, uv, fill) = match smear_geometry(rect, smear) {
      None => (rect, UvRect::default(), Fill::Sprite),
      Some((box_rect, uv, offset)) => (box_rect, uv, Fill::Smear(offset)),
    };

    unsafe {
      set_viewport(ctx, self.canvas_width, self.canvas_height);
      self.draw_quad_locked(
        ctx,
        dst_rtv,
        &sprite.srv,
        Quad {
          rect: quad_rect,
          shape: OverlayShape::Rect,
          corner_radius: 0.0,
          opacity: self.cursor_opacity,
          uv,
          // No grade: this is a bitmap of a pointer, not picture.
          grade: Grade::default(),
          fill,
        },
      )?;
    }

    Ok(())
  }

  /// The only thing left in the fullscreen constant buffer is the texel size,
  /// which the chroma pass uses to average a 2x2 block. The grade moved to the
  /// overlay buffer when it became per-layer.
  unsafe fn upload_params(&self, ctx: &ID3D11DeviceContext) -> Result<()> {
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe {
      ctx.Map(
        &self.constants,
        0,
        D3D11_MAP_WRITE_DISCARD,
        0,
        Some(&mut mapped),
      )?;
      let values = [
        1.0f32 / self.canvas_width.max(1) as f32,
        1.0 / self.canvas_height.max(1) as f32,
        0.0,
        0.0,
      ];
      std::ptr::copy_nonoverlapping(values.as_ptr(), mapped.pData as *mut f32, 8);
      ctx.Unmap(&self.constants, 0);
    }
    Ok(())
  }
}

fn compile(source: &str, entry: &str, target: &str) -> Result<ID3DBlob> {
  let entry_z = format!("{entry}\0");
  let target_z = format!("{target}\0");
  let mut code: Option<ID3DBlob> = None;
  let mut errors: Option<ID3DBlob> = None;

  let result = unsafe {
    D3DCompile(
      source.as_ptr() as *const _,
      source.len(),
      None,
      None,
      None,
      PCSTR(entry_z.as_ptr()),
      PCSTR(target_z.as_ptr()),
      D3DCOMPILE_OPTIMIZATION_LEVEL3,
      0,
      &mut code,
      Some(&mut errors),
    )
  };

  if let Err(e) = result {
    // The error blob says which line and why; without it this is just an HRESULT.
    let detail = errors
      .as_ref()
      .map(|b| unsafe {
        let ptr = b.GetBufferPointer() as *const u8;
        let len = b.GetBufferSize();
        String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len)).to_string()
      })
      .unwrap_or_default();
    panic!("shader {entry} failed to compile: {detail} ({e})");
  }

  Ok(code.expect("shader bytecode"))
}

fn blob(b: &ID3DBlob) -> &[u8] {
  unsafe { std::slice::from_raw_parts(b.GetBufferPointer() as *const u8, b.GetBufferSize()) }
}

unsafe fn set_viewport(ctx: &ID3D11DeviceContext, width: u32, height: u32) {
  let viewport = D3D11_VIEWPORT {
    TopLeftX: 0.0,
    TopLeftY: 0.0,
    Width: width as f32,
    Height: height as f32,
    MinDepth: 0.0,
    MaxDepth: 1.0,
  };
  unsafe { ctx.RSSetViewports(Some(&[viewport])) };
}

fn create_texture(
  gpu: &Gpu,
  width: u32,
  height: u32,
  format: DXGI_FORMAT,
  bind: u32,
) -> Result<ID3D11Texture2D> {
  let desc = D3D11_TEXTURE2D_DESC {
    Width: width,
    Height: height,
    MipLevels: 1,
    ArraySize: 1,
    Format: format,
    SampleDesc: DXGI_SAMPLE_DESC {
      Count: 1,
      Quality: 0,
    },
    Usage: D3D11_USAGE_DEFAULT,
    BindFlags: bind,
    CPUAccessFlags: 0,
    MiscFlags: 0,
  };
  let mut texture = None;
  unsafe {
    gpu
      .device
      .CreateTexture2D(&desc, None, Some(&mut texture))?
  };
  Ok(texture.expect("texture"))
}

fn create_srv(
  gpu: &Gpu,
  texture: &ID3D11Texture2D,
  format: DXGI_FORMAT,
) -> Result<ID3D11ShaderResourceView> {
  let desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
    Format: format,
    ViewDimension: D3D11_SRV_DIMENSION_TEXTURE2D,
    Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
      Texture2D: D3D11_TEX2D_SRV {
        MostDetailedMip: 0,
        MipLevels: 1,
      },
    },
  };
  let mut view = None;
  unsafe {
    gpu
      .device
      .CreateShaderResourceView(texture, Some(&desc), Some(&mut view))?
  };
  Ok(view.expect("srv"))
}

/// Render target view onto one plane of a planar texture.
///
/// The plane is chosen by the view format: R8 is the Y plane of an NV12
/// surface, R8G8 the interleaved CbCr plane at half resolution.
fn create_planar_rtv(
  gpu: &Gpu,
  texture: &ID3D11Texture2D,
  format: DXGI_FORMAT,
) -> Result<ID3D11RenderTargetView> {
  let desc = D3D11_RENDER_TARGET_VIEW_DESC {
    Format: format,
    ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
    Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 {
      Texture2D: D3D11_TEX2D_RTV { MipSlice: 0 },
    },
  };
  let mut view = None;
  unsafe {
    gpu
      .device
      .CreateRenderTargetView(texture, Some(&desc), Some(&mut view))?
  };
  Ok(view.expect("planar rtv"))
}

/// A dynamic constant buffer of `bytes`, which must be a multiple of 16.
pub fn create_constant_buffer(gpu: &Gpu, bytes: u32) -> Result<ID3D11Buffer> {
  let desc = D3D11_BUFFER_DESC {
    ByteWidth: bytes,
    Usage: D3D11_USAGE_DYNAMIC,
    BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
    CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
    ..Default::default()
  };

  let mut buffer = None;
  unsafe { gpu.device.CreateBuffer(&desc, None, Some(&mut buffer))? };
  Ok(buffer.expect("constant buffer"))
}

pub fn create_rtv(gpu: &Gpu, texture: &ID3D11Texture2D) -> Result<ID3D11RenderTargetView> {
  let mut view = None;
  unsafe {
    gpu
      .device
      .CreateRenderTargetView(texture, None, Some(&mut view))?
  };
  Ok(view.expect("rtv"))
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
    assert_eq!(DEFAULT_LAYER_ORDER, [Layer::Video, Layer::Cursor, Layer::Webcam]);
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
