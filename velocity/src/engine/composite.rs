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

pub use crate::engine::layout::*;

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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_empty_table_has_nothing_at_any_id() {
    // The fallback path: no table set at all, which is what every caller from
    // before per-sample bitmaps looks like.
    let images = CursorImages::default();
    assert!(images.get(0).is_none());
    assert!(images.get(9).is_none());
  }
}
