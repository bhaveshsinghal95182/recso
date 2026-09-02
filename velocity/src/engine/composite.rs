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
    }
  }
}

impl WebcamLayout {
  pub fn is_visible(&self) -> bool {
    !self.rect.is_empty() && self.opacity > 0.0
  }
}

/// The shaders, blend state and constant buffer the overlay passes need.
pub struct Overlays {
  vs: ID3D11VertexShader,
  ps_overlay: ID3D11PixelShader,
  ps_sprite: ID3D11PixelShader,
  blend: ID3D11BlendState,
  constants: ID3D11Buffer,
}

impl Overlays {
  pub fn new(
    gpu: &Gpu,
    vs: ID3D11VertexShader,
    ps_overlay: ID3D11PixelShader,
    ps_sprite: ID3D11PixelShader,
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

    let constants = super::render::create_constant_buffer(gpu, 16 * 4)?;

    Ok(Self {
      vs,
      ps_overlay,
      ps_sprite,
      blend: blend.unwrap(),
      constants,
    })
  }

  /// Draw one textured quad into `dst_rtv`.
  ///
  /// `sprite` picks the pixel shader: sprites take their alpha from the image
  /// (the cursor is a PNG with transparency), overlays are opaque sources that
  /// get their edge from the shape mask.
  ///
  /// Caller holds the render lock and owns viewport/topology restoration -- this
  /// sets what it needs and leaves nothing bound.
  #[allow(clippy::too_many_arguments)]
  pub fn draw(
    &self,
    ctx: &ID3D11DeviceContext,
    dst_rtv: &ID3D11RenderTargetView,
    source: &ID3D11ShaderResourceView,
    dst_width: u32,
    dst_height: u32,
    rect: Rect,
    shape: OverlayShape,
    corner_radius: f32,
    opacity: f32,
    sprite: bool,
  ) -> Result<()> {
    if rect.is_empty() || opacity <= 0.0 {
      return Ok(());
    }

    let ndc = rect.to_ndc(dst_width, dst_height);

    unsafe {
      self.upload(
        ctx,
        ndc,
        [rect.width * 0.5, rect.height * 0.5],
        corner_radius,
        shape,
        opacity,
      )?;

      ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
      ctx.IASetInputLayout(None);
      ctx.VSSetShader(&self.vs, None);
      // The rect lives in b1 and the VS reads it too, so it has to be bound on
      // both stages -- binding it only to the pixel shader draws a
      // zero-size quad and nothing appears.
      ctx.VSSetConstantBuffers(1, Some(&[Some(self.constants.clone())]));
      ctx.PSSetConstantBuffers(1, Some(&[Some(self.constants.clone())]));
      ctx.PSSetShader(
        if sprite {
          &self.ps_sprite
        } else {
          &self.ps_overlay
        },
        None,
      );
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

  unsafe fn upload(
    &self,
    ctx: &ID3D11DeviceContext,
    ndc: [f32; 4],
    half_size: [f32; 2],
    corner_radius: f32,
    shape: OverlayShape,
    opacity: f32,
  ) -> Result<()> {
    let values = [
      ndc[0],
      ndc[1],
      ndc[2],
      ndc[3],
      half_size[0],
      half_size[1],
      corner_radius,
      match shape {
        OverlayShape::Rect => 0.0,
        OverlayShape::Ellipse => 1.0,
      },
      opacity,
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
    unsafe { gpu.device.CreateShaderResourceView(&texture, None, Some(&mut srv))? };

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

/// One recorded cursor position.
///
/// Positions are normalised 0..1 against the *source* video, so they survive
/// the video being scaled into a different canvas. That is the same convention
/// the editor's compositor uses.
#[derive(Clone, Copy, Debug)]
pub struct CursorSample {
  pub timestamp_ms: f64,
  pub x: f32,
  pub y: f32,
  pub visible: bool,
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
    let upper = self.samples.partition_point(|s| s.timestamp_ms <= timestamp_ms);
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
  fn a_hidden_sample_hides_the_cursor() {
    let track = CursorTrack::new(vec![
      sample(0.0, 0.0),
      CursorSample {
        timestamp_ms: 100.0,
        x: 1.0,
        y: 1.0,
        visible: false,
      },
    ]);

    assert!(track.sample_at(50.0).is_some());
    assert!(track.sample_at(150.0).is_none());
  }

  #[test]
  fn samples_are_sorted_on_the_way_in() {
    let track = CursorTrack::new(vec![sample(200.0, 1.0), sample(0.0, 0.0), sample(100.0, 0.5)]);
    assert_eq!(track.len(), 3);
    assert_eq!(track.sample_at(150.0).unwrap().x, 0.5);
  }
}
