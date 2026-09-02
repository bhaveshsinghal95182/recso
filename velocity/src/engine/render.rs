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
  CursorTrack, OverlayShape, Overlays, Rect, SpriteTexture, WebcamLayout,
};
use crate::engine::d3d::{gpu, Gpu};

const HLSL: &str = include_str!("shaders.hlsl");

/// Matches the editor's compositor default, so switching paths does not resize
/// the pointer.
const DEFAULT_CURSOR_SIZE_PX: f32 = 22.0;

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
  pub fn is_identity(&self) -> bool {
    self.brightness == 0.0 && self.contrast == 1.0 && self.saturation == 1.0
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

pub struct RenderChain {
  width: u32,
  height: u32,

  vs: ID3D11VertexShader,
  ps_convert: ID3D11PixelShader,
  ps_effect: ID3D11PixelShader,
  ps_to_y: ID3D11PixelShader,
  ps_to_uv: ID3D11PixelShader,
  sampler: ID3D11SamplerState,
  constants: ID3D11Buffer,

  /// One NV12 source per destination slot, so any frame the player still holds
  /// can be re-rendered without going back to the decoder.
  sources: Vec<Source>,

  /// The webcam layer, when a recording has one.
  ///
  /// Per-slot NV12 like the desktop, for the same reason: moving or resizing
  /// the webcam box has to re-render the frames already in the queue, not go
  /// back to the decoder for them.
  webcam: Option<WebcamLayer>,
  webcam_layout: WebcamLayout,

  /// The cursor image, and where it sits in each staged slot.
  ///
  /// The position depends on the frame's timestamp, so it is resolved once at
  /// stage time and remembered -- a re-render must put the cursor back exactly
  /// where it was, not where the playhead has since moved to.
  cursor: Option<SpriteTexture>,
  cursor_track: CursorTrack,
  cursor_size: f32,
  cursor_opacity: f32,
  slot_cursor: Vec<Option<Rect>>,

  overlays: Overlays,

  /// Ping-pong target, only used when at least one adjustable pass runs.
  intermediate_rtv: ID3D11RenderTargetView,
  intermediate_srv: ID3D11ShaderResourceView,

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

  params: EffectParams,
}

impl RenderChain {
  /// `slots` is how many decoded frames the chain can hold at once. The player
  /// passes its pool size; the exporter only ever needs one.
  pub fn new(width: u32, height: u32, slots: usize) -> Result<Self> {
    let gpu = gpu()?;

    let vs_blob = compile(HLSL, "vs_fullscreen", "vs_5_0")?;
    let convert_blob = compile(HLSL, "ps_nv12_to_bgra", "ps_5_0")?;
    let effect_blob = compile(HLSL, "ps_effect", "ps_5_0")?;
    let to_y_blob = compile(HLSL, "ps_bgra_to_y", "ps_5_0")?;
    let to_uv_blob = compile(HLSL, "ps_bgra_to_uv", "ps_5_0")?;
    let quad_blob = compile(HLSL, "vs_quad", "vs_5_0")?;
    let overlay_blob = compile(HLSL, "ps_overlay", "ps_5_0")?;
    let sprite_blob = compile(HLSL, "ps_sprite", "ps_5_0")?;

    let mut vs = None;
    let mut ps_convert = None;
    let mut ps_effect = None;
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
        .CreatePixelShader(blob(&effect_blob), None, Some(&mut ps_effect))?;
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
    }

    let overlays = Overlays::new(
      gpu,
      vs_quad.expect("quad vertex shader"),
      ps_overlay.expect("overlay shader"),
      ps_sprite.expect("sprite shader"),
    )?;

    // Three effect floats plus a texel size, padded to a 16-byte multiple.
    let constants = create_constant_buffer(gpu, 32)?;

    let mut sources = Vec::with_capacity(slots.max(1));
    for _ in 0..slots.max(1) {
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

    let bgra_bind = (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32;

    let intermediate = create_texture(gpu, width, height, DXGI_FORMAT_B8G8R8A8_UNORM, bgra_bind)?;
    let intermediate_rtv = create_rtv(gpu, &intermediate)?;
    let intermediate_srv = create_srv(gpu, &intermediate, DXGI_FORMAT_B8G8R8A8_UNORM)?;

    let output = create_texture(gpu, width, height, DXGI_FORMAT_B8G8R8A8_UNORM, bgra_bind)?;
    let output_rtv = create_rtv(gpu, &output)?;
    let output_srv = create_srv(gpu, &output, DXGI_FORMAT_B8G8R8A8_UNORM)?;

    // NV12 needs even dimensions; the chroma plane is exactly half in each axis.
    let nv12_out = create_texture(gpu, width & !1, height & !1, DXGI_FORMAT_NV12, bgra_bind)?;
    let rtv_y = create_planar_rtv(gpu, &nv12_out, DXGI_FORMAT_R8_UNORM)?;
    let rtv_uv = create_planar_rtv(gpu, &nv12_out, DXGI_FORMAT_R8G8_UNORM)?;

    Ok(Self {
      width,
      height,
      vs: vs.expect("vertex shader"),
      ps_convert: ps_convert.expect("convert shader"),
      ps_effect: ps_effect.expect("effect shader"),
      ps_to_y: ps_to_y.expect("to-y shader"),
      ps_to_uv: ps_to_uv.expect("to-uv shader"),
      sampler: sampler.expect("sampler"),
      constants,
      sources,
      intermediate_rtv,
      intermediate_srv,
      output,
      output_rtv,
      output_srv,
      nv12_out,
      rtv_y,
      rtv_uv,
      params: EffectParams::default(),
      webcam: None,
      webcam_layout: WebcamLayout::default(),
      cursor: None,
      cursor_track: CursorTrack::default(),
      cursor_size: DEFAULT_CURSOR_SIZE_PX,
      cursor_opacity: 1.0,
      slot_cursor: vec![None; slots.max(1)],
      overlays,
    })
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

  pub fn set_webcam_layout(&mut self, layout: WebcamLayout) {
    self.webcam_layout = layout;
  }

  /// Copy a decoded webcam frame into a slot.
  ///
  /// Slots without one keep whatever they had; the caller decides whether that
  /// is the right frame, because holding the previous camera image is correct
  /// when the camera is slower than the screen and wrong after a seek.
  pub fn stage_webcam(&mut self, slot: usize, src: &ID3D11Texture2D, subresource: u32) -> Result<()> {
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

  pub fn set_cursor_image(&mut self, sprite: Option<SpriteTexture>) {
    self.cursor = sprite;
  }

  pub fn set_cursor_track(&mut self, track: CursorTrack) {
    self.cursor_track = track;
  }

  pub fn set_cursor_style(&mut self, size: f32, opacity: f32) {
    self.cursor_size = size.max(0.0);
    self.cursor_opacity = opacity.clamp(0.0, 1.0);
  }

  /// Resolve where the cursor sits for a frame, and remember it against the slot.
  ///
  /// Done at stage time rather than render time so a later re-render -- a
  /// grading change, a webcam move -- puts the cursor back where that frame had
  /// it instead of where the playhead is now.
  pub fn stage_cursor(&mut self, slot: usize, timestamp_ms: f64) {
    let index = slot % self.slot_cursor.len();
    self.slot_cursor[index] = self.resolve_cursor_rect(timestamp_ms);
  }

  fn resolve_cursor_rect(&self, timestamp_ms: f64) -> Option<Rect> {
    if self.cursor_opacity <= 0.0 || self.cursor_size <= 0.0 {
      return None;
    }

    let sprite = self.cursor.as_ref()?;
    let sample = self.cursor_track.sample_at(timestamp_ms)?;

    // The image keeps its aspect ratio; `cursor_size` is its height.
    let scale = self.cursor_size / sprite.height.max(1) as f32;
    let width = sprite.width as f32 * scale;
    let height = sprite.height as f32 * scale;

    // Normalised position is the cursor's *point*, so the image is offset by
    // its hotspot. Skipping this puts an arrow's tip below and right of the
    // place the user actually clicked.
    Some(Rect {
      x: sample.x * self.width as f32 - sprite.hotspot_x * scale,
      y: sample.y * self.height as f32 - sprite.hotspot_y * scale,
      width,
      height,
    })
  }

  pub fn set_params(&mut self, params: EffectParams) {
    self.params = params;
  }

  /// Copy a decoded frame into a slot's own NV12 texture.
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

    unsafe {
      self.upload_params(ctx)?;
      ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
      ctx.IASetInputLayout(None);
      ctx.VSSetShader(&self.vs, None);
      ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
      ctx.PSSetConstantBuffers(0, Some(&[Some(self.constants.clone())]));
      ctx.PSSetShaderResources(0, Some(&[Some(self.output_srv.clone())]));

      // Luma at full resolution into plane 0.
      set_viewport(ctx, self.width, self.height);
      ctx.OMSetRenderTargets(Some(&[Some(self.rtv_y.clone())]), None);
      ctx.PSSetShader(&self.ps_to_y, None);
      ctx.Draw(3, 0);

      // Chroma at half resolution into plane 1. This is where the 4:2:0
      // subsampling actually happens.
      set_viewport(ctx, self.width / 2, self.height / 2);
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

  fn render_locked(&self, slot: usize, dst_rtv: &ID3D11RenderTargetView) -> Result<()> {
    let gpu = gpu()?;
    let ctx = &gpu.context;
    let source = &self.sources[slot % self.sources.len()];

    unsafe {
      set_viewport(ctx, self.width, self.height);
      ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
      // No vertex or index buffers: the VS builds the triangle from SV_VertexID.
      ctx.IASetInputLayout(None);
      ctx.VSSetShader(&self.vs, None);
      ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));

      let identity = self.params.is_identity();

      // Pass 1: NV12 -> BGRA. With no effects this writes straight to dst and
      // the whole chain is a single pass.
      let first_target = if identity {
        dst_rtv.clone()
      } else {
        self.intermediate_rtv.clone()
      };
      ctx.OMSetRenderTargets(Some(&[Some(first_target)]), None);
      ctx.PSSetShader(&self.ps_convert, None);
      ctx.PSSetShaderResources(
        0,
        Some(&[Some(source.srv_y.clone()), Some(source.srv_uv.clone())]),
      );
      ctx.Draw(3, 0);

      if !identity {
        // Unbind the intermediate as a source before binding it as a target, or
        // D3D11 silently drops one of the two bindings.
        ctx.PSSetShaderResources(0, Some(&[None, None]));

        self.upload_params(ctx)?;

        ctx.OMSetRenderTargets(Some(&[Some(dst_rtv.clone())]), None);
        ctx.PSSetShader(&self.ps_effect, None);
        ctx.PSSetConstantBuffers(0, Some(&[Some(self.constants.clone())]));
        ctx.PSSetShaderResources(0, Some(&[Some(self.intermediate_srv.clone())]));
        ctx.Draw(3, 0);
      }

      // Unbind the base source before the overlays start binding their own.
      ctx.PSSetShaderResources(0, Some(&[None, None]));

      // ---- overlays -------------------------------------------------------
      //
      // These run here, inside the chain, rather than in whatever consumes the
      // result. That is the same reason the effects sit before the
      // preview/export fork: one implementation, so the webcam cannot be in a
      // different place on screen than it is in the exported file.

      self.composite_webcam_locked(ctx, slot, dst_rtv)?;
      self.composite_cursor_locked(ctx, slot, dst_rtv)?;

      // Leave nothing bound: a slot's source becomes a copy destination again on
      // a later frame, and D3D11 refuses that while it is still an SRV.
      ctx.PSSetShaderResources(0, Some(&[None, None]));
      ctx.OMSetRenderTargets(Some(&[None]), None);
      ctx.Flush();
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

    let index = slot % webcam.sources.len();
    if !webcam.staged[index] {
      return Ok(());
    }

    let source = &webcam.sources[index];

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
      set_viewport(ctx, self.width, self.height);
      self.overlays.draw(
        ctx,
        dst_rtv,
        &webcam.bgra_srv,
        self.width,
        self.height,
        self.webcam_layout.rect,
        self.webcam_layout.shape,
        self.webcam_layout.corner_radius,
        self.webcam_layout.opacity,
        false,
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
  ) -> Result<()> {
    let Some(sprite) = self.cursor.as_ref() else {
      return Ok(());
    };
    let Some(rect) = self.slot_cursor[slot % self.slot_cursor.len()] else {
      return Ok(());
    };

    unsafe {
      set_viewport(ctx, self.width, self.height);
      self.overlays.draw(
        ctx,
        dst_rtv,
        &sprite.srv,
        self.width,
        self.height,
        rect,
        OverlayShape::Rect,
        0.0,
        self.cursor_opacity,
        true,
      )?;
    }

    Ok(())
  }

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
        self.params.brightness,
        self.params.contrast,
        self.params.saturation,
        0.0f32,
        1.0 / self.width as f32,
        1.0 / self.height as f32,
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
  unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut texture))? };
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
