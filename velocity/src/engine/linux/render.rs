//! The Linux GPU frame chain shared by preview and export.
//!
//! It mirrors Windows' coded-size conversion and ordered canvas quads so a
//! staged frame rerenders identically in the editor and export.
use crate::engine::layout::{Fill, Grade, OverlayShape, Quad, Rect, ShadowFill, UvRect};
use crate::engine::scene::{
  BackgroundRequest, EffectParams, Layer, SourceCrop, VideoLayout, DEFAULT_LAYER_ORDER,
};
use crate::engine::zoom::{ZoomState, ZoomTrack};
use std::sync::{Arc, OnceLock};

const WGSL: &str = include_str!("shaders.wgsl");
struct Gpu {
  device: wgpu::Device,
  queue: wgpu::Queue,
}
static GPU: OnceLock<Result<Arc<Gpu>, String>> = OnceLock::new();
fn gpu() -> Result<Arc<Gpu>, String> {
  GPU
    .get_or_init(|| {
      let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
      let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        apply_limit_buckets: false,
      }))
      .map_err(|e| format!("requesting high-performance GPU adapter: {e}"))?;
      #[cfg(test)]
      for found in pollster::block_on(instance.enumerate_adapters(wgpu::Backends::VULKAN)) {
        println!(
          "Available Vulkan adapter: {} ({:?})",
          found.get_info().name,
          found.get_info().device_type
        );
      }
      #[cfg(test)]
      println!("Linux render adapter: {}", adapter.get_info().name);
      let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
          .map_err(|e| format!("creating GPU device on {}: {e}", adapter.get_info().name))?;
      Ok(Arc::new(Gpu { device, queue }))
    })
    .clone()
}
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniform {
  rect_ndc: [f32; 4],
  half_size_px: [f32; 2],
  corner_radius_px: f32,
  shape: f32,
  opacity: f32,
  brightness: f32,
  contrast: f32,
  saturation: f32,
  uv_rect: [f32; 4],
  tint: [f32; 4],
  smear: [f32; 2],
  shadow_half_px: [f32; 2],
  shadow_softness_px: f32,
  _pad_to_vec3: [f32; 3],
  _pad1: [f32; 4],
}
struct Source {
  planes: [wgpu::Texture; 3],
  views: [wgpu::TextureView; 3],
}
struct Background {
  clear: [f32; 4],
  image: Option<(wgpu::Texture, wgpu::TextureView)>,
}
struct Pipelines {
  convert: wgpu::RenderPipeline,
  overlay: wgpu::RenderPipeline,
  sprite: wgpu::RenderPipeline,
  smear: wgpu::RenderPipeline,
  solid: wgpu::RenderPipeline,
  shadow: wgpu::RenderPipeline,
}
/// Staged I420 slots and one RGBA canvas used for preview and export.
pub(crate) struct RenderChain {
  gpu: Arc<Gpu>,
  coded: (u32, u32),
  display: (u32, u32),
  canvas: (u32, u32),
  sources: Vec<Source>,
  _video: wgpu::Texture,
  video_view: wgpu::TextureView,
  output: wgpu::Texture,
  output_view: wgpu::TextureView,
  sampler: wgpu::Sampler,
  conversion_layout: wgpu::BindGroupLayout,
  quad_layout: wgpu::BindGroupLayout,
  pipelines: Pipelines,
  layout: VideoLayout,
  params: EffectParams,
  crop: Option<SourceCrop>,
  zoom_track: ZoomTrack,
  slot_zoom: Vec<ZoomState>,
  layer_order: [Layer; 3],
  background: Background,
}
fn texture(
  d: &wgpu::Device,
  label: &'static str,
  size: (u32, u32),
  format: wgpu::TextureFormat,
  usage: wgpu::TextureUsages,
) -> wgpu::Texture {
  d.create_texture(&wgpu::TextureDescriptor {
    label: Some(label),
    size: wgpu::Extent3d {
      width: size.0,
      height: size.1,
      depth_or_array_layers: 1,
    },
    mip_level_count: 1,
    sample_count: 1,
    dimension: wgpu::TextureDimension::D2,
    format,
    usage,
    view_formats: &[],
  })
}
fn pipeline(
  d: &wgpu::Device,
  s: &wgpu::ShaderModule,
  layout: &wgpu::PipelineLayout,
  vs: &'static str,
  fs: &'static str,
  blend: Option<wgpu::BlendState>,
) -> wgpu::RenderPipeline {
  d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
    label: Some(fs),
    layout: Some(layout),
    vertex: wgpu::VertexState {
      module: s,
      entry_point: Some(vs),
      compilation_options: Default::default(),
      buffers: &[],
    },
    fragment: Some(wgpu::FragmentState {
      module: s,
      entry_point: Some(fs),
      compilation_options: Default::default(),
      targets: &[Some(wgpu::ColorTargetState {
        format: wgpu::TextureFormat::Rgba8Unorm,
        blend,
        write_mask: wgpu::ColorWrites::ALL,
      })],
    }),
    primitive: wgpu::PrimitiveState {
      topology: if vs == "vs_quad" {
        wgpu::PrimitiveTopology::TriangleStrip
      } else {
        wgpu::PrimitiveTopology::TriangleList
      },
      ..Default::default()
    },
    depth_stencil: None,
    multisample: Default::default(),
    multiview_mask: None,
    cache: None,
  })
}
impl RenderChain {
  /// Allocate coded-size I420 slots and a canvas-size RGBA target.
  pub(crate) fn new(
    coded: (u32, u32),
    display: (u32, u32),
    canvas: (u32, u32),
    slots: usize,
  ) -> Result<Self, String> {
    if coded.0 == 0 || coded.1 == 0 {
      return Err(format!("invalid coded size {}x{}", coded.0, coded.1));
    }
    let display = (
      if display.0 == 0 || display.0 > coded.0 {
        coded.0
      } else {
        display.0
      },
      if display.1 == 0 || display.1 > coded.1 {
        coded.1
      } else {
        display.1
      },
    );
    let canvas = (
      if canvas.0 < 2 { display.0 } else { canvas.0 },
      if canvas.1 < 2 { display.1 } else { canvas.1 },
    );
    let gpu = gpu()?;
    let d = &gpu.device;
    let shader = d.create_shader_module(wgpu::ShaderModuleDescriptor {
      label: Some("Linux render WGSL"),
      source: wgpu::ShaderSource::Wgsl(WGSL.into()),
    });
    let sampler = d.create_sampler(&wgpu::SamplerDescriptor {
      address_mode_u: wgpu::AddressMode::ClampToEdge,
      address_mode_v: wgpu::AddressMode::ClampToEdge,
      address_mode_w: wgpu::AddressMode::ClampToEdge,
      mag_filter: wgpu::FilterMode::Linear,
      min_filter: wgpu::FilterMode::Linear,
      mipmap_filter: wgpu::MipmapFilterMode::Linear,
      ..Default::default()
    });
    let tex_entry = |binding| wgpu::BindGroupLayoutEntry {
      binding,
      visibility: wgpu::ShaderStages::FRAGMENT,
      ty: wgpu::BindingType::Texture {
        sample_type: wgpu::TextureSampleType::Float { filterable: true },
        view_dimension: wgpu::TextureViewDimension::D2,
        multisampled: false,
      },
      count: None,
    };
    let conversion_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
      label: Some("I420 planes"),
      entries: &[
        wgpu::BindGroupLayoutEntry {
          binding: 0,
          visibility: wgpu::ShaderStages::FRAGMENT,
          ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
          count: None,
        },
        tex_entry(1),
        tex_entry(2),
        tex_entry(3),
      ],
    });
    let quad_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
      label: Some("quad"),
      entries: &[
        wgpu::BindGroupLayoutEntry {
          binding: 0,
          visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
          ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
          },
          count: None,
        },
        tex_entry(1),
      ],
    });
    let convert_pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
      label: Some("convert"),
      bind_group_layouts: &[Some(&conversion_layout)],
      immediate_size: 0,
    });
    let quad_pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
      label: Some("quad"),
      bind_group_layouts: &[Some(&conversion_layout), Some(&quad_layout)],
      immediate_size: 0,
    });
    let blend = Some(wgpu::BlendState {
      color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::SrcAlpha,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
      },
      alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
      },
    });
    let pipelines = Pipelines {
      convert: pipeline(
        d,
        &shader,
        &convert_pl,
        "vs_fullscreen",
        "ps_i420_to_rgba",
        None,
      ),
      overlay: pipeline(d, &shader, &quad_pl, "vs_quad", "ps_overlay", blend),
      sprite: pipeline(d, &shader, &quad_pl, "vs_quad", "ps_sprite", blend),
      smear: pipeline(d, &shader, &quad_pl, "vs_quad", "ps_smear", blend),
      solid: pipeline(d, &shader, &quad_pl, "vs_quad", "ps_solid", blend),
      shadow: pipeline(d, &shader, &quad_pl, "vs_quad", "ps_shadow", blend),
    };
    let mut sources = Vec::with_capacity(slots.max(1));
    for _ in 0..slots.max(1) {
      let dims = [
        coded,
        (coded.0.div_ceil(2), coded.1.div_ceil(2)),
        (coded.0.div_ceil(2), coded.1.div_ceil(2)),
      ];
      let planes = std::array::from_fn(|i| {
        texture(
          d,
          "I420 plane",
          dims[i],
          wgpu::TextureFormat::R8Unorm,
          wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
        )
      });
      let views = std::array::from_fn(|i| planes[i].create_view(&Default::default()));
      sources.push(Source { planes, views });
    }
    let video = texture(
      d,
      "converted video",
      coded,
      wgpu::TextureFormat::Rgba8Unorm,
      wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
    );
    let video_view = video.create_view(&Default::default());
    let output = texture(
      d,
      "RGBA output",
      canvas,
      wgpu::TextureFormat::Rgba8Unorm,
      wgpu::TextureUsages::RENDER_ATTACHMENT
        | wgpu::TextureUsages::COPY_SRC
        | wgpu::TextureUsages::TEXTURE_BINDING,
    );
    let output_view = output.create_view(&Default::default());
    Ok(Self {
      gpu,
      coded,
      display,
      canvas,
      sources,
      _video: video,
      video_view,
      output,
      output_view,
      sampler,
      conversion_layout,
      quad_layout,
      pipelines,
      layout: VideoLayout::covering(canvas.0, canvas.1),
      params: EffectParams::default(),
      crop: None,
      zoom_track: ZoomTrack::default(),
      slot_zoom: vec![ZoomState::default(); slots.max(1)],
      layer_order: DEFAULT_LAYER_ORDER,
      background: Background {
        clear: [0.0, 0.0, 0.0, 1.0],
        image: None,
      },
    })
  }
  /// Size of the actual RGBA output.
  pub(crate) fn output_size(&self) -> (u32, u32) {
    self.canvas
  }
  pub(crate) fn set_layout(&mut self, v: VideoLayout) {
    self.layout = v.sanitized();
  }
  pub(crate) fn set_params(&mut self, v: EffectParams) {
    self.params = v;
  }
  pub(crate) fn set_source_crop(&mut self, v: Option<SourceCrop>) {
    self.crop = v.and_then(SourceCrop::resolve);
  }
  pub(crate) fn set_zoom_track(&mut self, v: ZoomTrack) {
    self.zoom_track = v;
  }
  pub(crate) fn set_layer_order(&mut self, v: [Layer; 3]) {
    self.layer_order = v;
  }
  /// Upload a static image or retain a solid clear colour.
  pub(crate) fn set_background(&mut self, request: BackgroundRequest) -> Result<(), String> {
    let image = if let Some(image) = request.image {
      let bytes = (image.width as usize)
        .checked_mul(image.height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| {
          format!(
            "background {}x{} byte count overflow",
            image.width, image.height
          )
        })?;
      if image.width == 0 || image.height == 0 || image.pixels.len() != bytes {
        return Err(format!(
          "background {}x{} requires {bytes} RGBA bytes, got {}",
          image.width,
          image.height,
          image.pixels.len()
        ));
      }
      let tex = texture(
        &self.gpu.device,
        "background",
        (image.width, image.height),
        wgpu::TextureFormat::Rgba8Unorm,
        wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
      );
      self.gpu.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
          texture: &tex,
          mip_level: 0,
          origin: wgpu::Origin3d::ZERO,
          aspect: wgpu::TextureAspect::All,
        },
        &image.pixels,
        wgpu::TexelCopyBufferLayout {
          offset: 0,
          bytes_per_row: Some(image.width * 4),
          rows_per_image: Some(image.height),
        },
        wgpu::Extent3d {
          width: image.width,
          height: image.height,
          depth_or_array_layers: 1,
        },
      );
      let view = tex.create_view(&Default::default());
      Some((tex, view))
    } else {
      None
    };
    self.background = Background {
      clear: request.clear,
      image,
    };
    Ok(())
  }
  /// Retain all three planes of a decoded frame in a reusable slot.
  pub(crate) fn stage(
    &mut self,
    slot: usize,
    y: &[u8],
    u: &[u8],
    v: &[u8],
    strides: (usize, usize, usize),
  ) -> Result<(), String> {
    let source = &self.sources[slot % self.sources.len()];
    for (i, (data, stride)) in [(y, strides.0), (u, strides.1), (v, strides.2)]
      .into_iter()
      .enumerate()
    {
      let dims = if i == 0 {
        self.coded
      } else {
        (self.coded.0.div_ceil(2), self.coded.1.div_ceil(2))
      };
      let need = stride
        .checked_mul(dims.1.saturating_sub(1) as usize)
        .and_then(|n| n.checked_add(dims.0 as usize))
        .ok_or_else(|| format!("slot {slot} plane {i}: stride overflows"))?;
      if stride < dims.0 as usize || stride > u32::MAX as usize || data.len() < need {
        return Err(format!(
          "slot {slot} plane {i}: {}x{} stride {stride} needs {need} bytes, got {}",
          dims.0,
          dims.1,
          data.len()
        ));
      }
      self.gpu.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
          texture: &source.planes[i],
          mip_level: 0,
          origin: wgpu::Origin3d::ZERO,
          aspect: wgpu::TextureAspect::All,
        },
        data,
        wgpu::TexelCopyBufferLayout {
          offset: 0,
          bytes_per_row: Some(stride as u32),
          rows_per_image: Some(dims.1),
        },
        wgpu::Extent3d {
          width: dims.0,
          height: dims.1,
          depth_or_array_layers: 1,
        },
      );
    }
    Ok(())
  }
  /// Resolve and pin this frame's zoom for later rerenders.
  pub(crate) fn stage_timeline(&mut self, slot: usize, timestamp_ms: f64) {
    let i = slot % self.slot_zoom.len();
    self.slot_zoom[i] = self.zoom_track.state_at(timestamp_ms, self.layout.rect);
    // TODO(R2): stage cursor and webcam state.
  }
  fn video_uv(&self) -> UvRect {
    let visible = [
      self.display.0 as f32 / self.coded.0.max(1) as f32,
      self.display.1 as f32 / self.coded.1.max(1) as f32,
    ];
    match self.crop {
      None => UvRect {
        scale: visible,
        offset: [0.0, 0.0],
      },
      Some(crop) => UvRect {
        scale: [crop.width() * visible[0], crop.height() * visible[1]],
        offset: [crop.left * visible[0], crop.top * visible[1]],
      },
    }
  }
  fn conversion_bindings(&self, source: &Source) -> wgpu::BindGroup {
    self
      .gpu
      .device
      .create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("I420 source"),
        layout: &self.conversion_layout,
        entries: &[
          wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::Sampler(&self.sampler),
          },
          wgpu::BindGroupEntry {
            binding: 1,
            resource: wgpu::BindingResource::TextureView(&source.views[0]),
          },
          wgpu::BindGroupEntry {
            binding: 2,
            resource: wgpu::BindingResource::TextureView(&source.views[1]),
          },
          wgpu::BindGroupEntry {
            binding: 3,
            resource: wgpu::BindingResource::TextureView(&source.views[2]),
          },
        ],
      })
  }
  fn draw_quad(
    &self,
    encoder: &mut wgpu::CommandEncoder,
    target: &wgpu::TextureView,
    source: &wgpu::TextureView,
    quad: Quad,
  ) {
    if quad.rect.is_empty() || quad.opacity <= 0.0 {
      return;
    }
    let (tint, smear, half, softness, pipe) = match quad.fill {
      Fill::Texture => ([0.0; 4], [0.0; 2], [0.0; 2], 0.0, &self.pipelines.overlay),
      Fill::Sprite => ([0.0; 4], [0.0; 2], [0.0; 2], 0.0, &self.pipelines.sprite),
      Fill::Smear(v) => ([0.0; 4], v, [0.0; 2], 0.0, &self.pipelines.smear),
      Fill::Solid(v) => (v, [0.0; 2], [0.0; 2], 0.0, &self.pipelines.solid),
      Fill::Shadow(v) => (
        v.colour,
        [0.0; 2],
        v.half,
        v.softness,
        &self.pipelines.shadow,
      ),
    };
    let uniform = Uniform {
      rect_ndc: quad.rect.to_ndc(self.canvas.0, self.canvas.1),
      half_size_px: [quad.rect.width * 0.5, quad.rect.height * 0.5],
      corner_radius_px: quad.corner_radius,
      shape: if quad.shape == OverlayShape::Ellipse {
        1.0
      } else {
        0.0
      },
      opacity: quad.opacity,
      brightness: quad.grade.brightness,
      contrast: quad.grade.contrast,
      saturation: quad.grade.saturation,
      uv_rect: [
        quad.uv.scale[0],
        quad.uv.scale[1],
        quad.uv.offset[0],
        quad.uv.offset[1],
      ],
      tint,
      smear,
      shadow_half_px: half,
      shadow_softness_px: softness,
      _pad_to_vec3: [0.0; 3],
      _pad1: [0.0; 4],
    };
    let buffer = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
      label: Some("quad uniform"),
      size: std::mem::size_of::<Uniform>() as u64,
      usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
      mapped_at_creation: false,
    });
    self
      .gpu
      .queue
      .write_buffer(&buffer, 0, bytemuck::bytes_of(&uniform));
    let bindings = self
      .gpu
      .device
      .create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("quad source"),
        layout: &self.quad_layout,
        entries: &[
          wgpu::BindGroupEntry {
            binding: 0,
            resource: buffer.as_entire_binding(),
          },
          wgpu::BindGroupEntry {
            binding: 1,
            resource: wgpu::BindingResource::TextureView(source),
          },
        ],
      });
    let dummy = self.conversion_bindings(&self.sources[0]);
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
      label: Some("quad"),
      color_attachments: &[Some(wgpu::RenderPassColorAttachment {
        view: target,
        resolve_target: None,
        ops: wgpu::Operations {
          load: wgpu::LoadOp::Load,
          store: wgpu::StoreOp::Store,
        },
        depth_slice: None,
      })],
      depth_stencil_attachment: None,
      timestamp_writes: None,
      occlusion_query_set: None,
      multiview_mask: None,
    });
    pass.set_pipeline(pipe);
    pass.set_bind_group(0, &dummy, &[]);
    pass.set_bind_group(1, &bindings, &[]);
    pass.draw(0..4, 0..1);
  }
  /// Convert at coded size, then paint background and ordered canvas layers.
  pub(crate) fn render_slot(&self, slot: usize) -> Result<(), String> {
    let mut encoder = self
      .gpu
      .device
      .create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("frame"),
      });
    {
      let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("clear"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
          view: &self.output_view,
          resolve_target: None,
          ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color {
              r: self.background.clear[0] as f64,
              g: self.background.clear[1] as f64,
              b: self.background.clear[2] as f64,
              a: self.background.clear[3] as f64,
            }),
            store: wgpu::StoreOp::Store,
          },
          depth_slice: None,
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
      });
    }
    let bindings = self.conversion_bindings(&self.sources[slot % self.sources.len()]);
    {
      let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("convert"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
          view: &self.video_view,
          resolve_target: None,
          ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
            store: wgpu::StoreOp::Store,
          },
          depth_slice: None,
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
      });
      pass.set_pipeline(&self.pipelines.convert);
      pass.set_bind_group(0, &bindings, &[]);
      pass.draw(0..3, 0..1);
    }
    if let Some((_, view)) = &self.background.image {
      self.draw_quad(
        &mut encoder,
        &self.output_view,
        view,
        Quad {
          rect: Rect::covering(self.canvas.0, self.canvas.1),
          shape: OverlayShape::Rect,
          corner_radius: 0.0,
          opacity: 1.0,
          uv: UvRect::default(),
          grade: Grade::default(),
          fill: Fill::Texture,
        },
      );
    }
    let zoom = self.slot_zoom[slot % self.slot_zoom.len()];
    for layer in self.layer_order {
      match layer {
        Layer::Video => self.composite_video(&mut encoder, zoom),
        Layer::Webcam => { /* TODO(R2): draw webcam. */ }
        Layer::Cursor => { /* TODO(R2): draw cursor. */ }
      }
    }
    self.gpu.queue.submit([encoder.finish()]);
    Ok(())
  }
  fn composite_video(&self, encoder: &mut wgpu::CommandEncoder, zoom: ZoomState) {
    let layout = &self.layout;
    if layout.rect.is_empty() {
      return;
    }
    let rect = zoom.apply(layout.rect);
    let corner = layout.corner_radius * zoom.scale;
    let border = layout.border_width * zoom.scale;
    if !rect.contains_canvas(self.canvas.0, self.canvas.1) {
      for shadow in &layout.shadows {
        let shadow = shadow.scaled(zoom.scale);
        if !shadow.is_visible() {
          continue;
        }
        self.draw_quad(
          encoder,
          &self.output_view,
          &self.video_view,
          Quad {
            rect: shadow.quad_rect(rect),
            shape: OverlayShape::Rect,
            corner_radius: corner,
            opacity: 1.0,
            uv: UvRect::default(),
            grade: Grade::default(),
            fill: Fill::Shadow(ShadowFill {
              colour: shadow.colour,
              half: [rect.width * 0.5, rect.height * 0.5],
              softness: shadow.softness(),
            }),
          },
        );
      }
    }
    if border > 0.0 {
      self.draw_quad(
        encoder,
        &self.output_view,
        &self.video_view,
        Quad {
          rect: rect.expanded(border),
          shape: OverlayShape::Rect,
          corner_radius: corner + border,
          opacity: 1.0,
          uv: UvRect::default(),
          grade: Grade::default(),
          fill: Fill::Solid(layout.border_colour),
        },
      );
    }
    self.draw_quad(
      encoder,
      &self.output_view,
      &self.video_view,
      Quad {
        rect,
        shape: OverlayShape::Rect,
        corner_radius: corner,
        opacity: 1.0,
        uv: self.video_uv(),
        grade: self.params.into(),
        fill: Fill::Texture,
      },
    );
  }
  /// Replace `out` with tightly packed RGBA bytes from the canvas.
  pub(crate) fn read_rgba(&self, out: &mut Vec<u8>) -> Result<(), String> {
    let row = self
      .canvas
      .0
      .checked_mul(4)
      .ok_or_else(|| format!("canvas {}x{} row overflows", self.canvas.0, self.canvas.1))?;
    let pitch =
      row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let buffer = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
      label: Some("RGBA readback"),
      size: pitch as u64 * self.canvas.1 as u64,
      usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
      mapped_at_creation: false,
    });
    let mut encoder = self
      .gpu
      .device
      .create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("readback"),
      });
    encoder.copy_texture_to_buffer(
      wgpu::TexelCopyTextureInfo {
        texture: &self.output,
        mip_level: 0,
        origin: wgpu::Origin3d::ZERO,
        aspect: wgpu::TextureAspect::All,
      },
      wgpu::TexelCopyBufferInfo {
        buffer: &buffer,
        layout: wgpu::TexelCopyBufferLayout {
          offset: 0,
          bytes_per_row: Some(pitch),
          rows_per_image: Some(self.canvas.1),
        },
      },
      wgpu::Extent3d {
        width: self.canvas.0,
        height: self.canvas.1,
        depth_or_array_layers: 1,
      },
    );
    self.gpu.queue.submit([encoder.finish()]);
    let slice = buffer.slice(..);
    let (sender, receiver) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
      let _ = sender.send(result);
    });
    self
      .gpu
      .device
      .poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: None,
      })
      .map_err(|e| {
        format!(
          "polling {}x{} RGBA readback: {e}",
          self.canvas.0, self.canvas.1
        )
      })?;
    receiver
      .recv()
      .map_err(|e| format!("receiving RGBA map result: {e}"))?
      .map_err(|e| format!("mapping RGBA readback: {e}"))?;
    let mapped = slice
      .get_mapped_range()
      .map_err(|e| format!("reading mapped RGBA bytes: {e}"))?;
    out.clear();
    for line in mapped
      .chunks_exact(pitch as usize)
      .take(self.canvas.1 as usize)
    {
      out.extend_from_slice(&line[..row as usize]);
    }
    drop(mapped);
    buffer.unmap();
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::engine::scene::RgbaImage;
  use crate::engine::zoom::ZoomRegion;
  fn chain(size: (u32, u32)) -> Option<RenderChain> {
    match RenderChain::new(size, size, size, 1) {
      Ok(chain) => Some(chain),
      Err(error) if error.contains("GPU adapter") => {
        println!("no adapter, skipping: {error}");
        None
      }
      Err(error) => panic!("render chain: {error}"),
    }
  }
  fn i420(rgb: [u8; 3], size: (u32, u32)) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let [r, g, b] = rgb.map(|v| v as f32 / 255.0);
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let cb = (b - y) / 1.8556;
    let cr = (r - y) / 1.5748;
    let q = |v: f32| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    (
      vec![q(y * 219.0 / 255.0 + 16.0 / 255.0); (size.0 * size.1) as usize],
      vec![
        q(cb * 224.0 / 255.0 + 128.0 / 255.0);
        (size.0.div_ceil(2) * size.1.div_ceil(2)) as usize
      ],
      vec![
        q(cr * 224.0 / 255.0 + 128.0 / 255.0);
        (size.0.div_ceil(2) * size.1.div_ceil(2)) as usize
      ],
    )
  }
  fn stage(chain: &mut RenderChain, colour: [u8; 3]) {
    let (y, u, v) = i420(colour, chain.coded);
    chain
      .stage(
        0,
        &y,
        &u,
        &v,
        (
          chain.coded.0 as usize,
          chain.coded.0.div_ceil(2) as usize,
          chain.coded.0.div_ceil(2) as usize,
        ),
      )
      .unwrap();
  }
  fn pixel(bytes: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * width + x) * 4) as usize;
    bytes[i..i + 4].try_into().unwrap()
  }
  fn near(actual: [u8; 4], expected: [u8; 3], tolerance: i16) {
    for i in 0..3 {
      assert!(
        (actual[i] as i16 - expected[i] as i16).abs() <= tolerance,
        "channel {i}: {actual:?} vs {expected:?}"
      );
    }
  }
  fn read(chain: &RenderChain) -> Vec<u8> {
    chain.render_slot(0).unwrap();
    let mut out = vec![9; 17];
    chain.read_rgba(&mut out).unwrap();
    out
  }
  #[test]
  fn conversion_readback_and_determinism() {
    let Some(mut chain) = chain((64, 48)) else {
      return;
    };
    println!("GPU render test running");
    let c = [105, 150, 205];
    stage(&mut chain, c);
    let first = read(&chain);
    assert_eq!(
      first.len(),
      (chain.output_size().0 * chain.output_size().1 * 4) as usize
    );
    near(pixel(&first, 64, 32, 24), c, 3);
    assert_eq!(first, read(&chain));
  }
  #[test]
  fn solid_background_and_rounded_video() {
    let Some(mut chain) = chain((64, 64)) else {
      return;
    };
    let c = [190, 110, 70];
    let b = [20, 40, 60];
    stage(&mut chain, c);
    chain
      .set_background(BackgroundRequest {
        clear: [
          b[0] as f32 / 255.0,
          b[1] as f32 / 255.0,
          b[2] as f32 / 255.0,
          1.0,
        ],
        image: None,
      })
      .unwrap();
    let mut layout = VideoLayout::covering(64, 64);
    layout.rect = Rect {
      x: 12.0,
      y: 12.0,
      width: 40.0,
      height: 40.0,
    };
    layout.corner_radius = 10.0;
    chain.set_layout(layout.clone());
    let pixels = read(&chain);
    near(pixel(&pixels, 64, 2, 2), b, 1);
    near(pixel(&pixels, 64, 32, 32), c, 3);
    near(
      pixel(&pixels, 64, layout.rect.x as u32, layout.rect.y as u32),
      b,
      3,
    );
    near(pixel(&pixels, 64, layout.rect.x as u32 + 2, 32), c, 3);
    near(pixel(&pixels, 64, layout.rect.x as u32 - 2, 32), b, 1);
  }
  #[test]
  fn image_background_stretches() {
    let Some(mut chain) = chain((64, 64)) else {
      return;
    };
    stage(&mut chain, [30, 60, 90]);
    chain.set_layout(VideoLayout {
      rect: Rect {
        x: 20.0,
        y: 20.0,
        width: 24.0,
        height: 24.0,
      },
      ..VideoLayout::covering(64, 64)
    });
    chain
      .set_background(BackgroundRequest {
        clear: [0.0, 0.0, 0.0, 1.0],
        image: Some(RgbaImage {
          width: 2,
          height: 2,
          pixels: vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
          ],
        }),
      })
      .unwrap();
    let pixels = read(&chain);
    near(pixel(&pixels, 64, 3, 3), [255, 0, 0], 1);
    near(pixel(&pixels, 64, 60, 60), [255, 255, 0], 1);
  }
  fn grade(c: [u8; 4], brightness: f32) -> [u8; 3] {
    let mut v = [0; 3];
    for i in 0..3 {
      let source = c[i] as f32 / 255.0;
      let graded = ((source - 0.5) * 1.0 + 0.5 + brightness).clamp(0.0, 1.0);
      v[i] = (graded * 255.0).round() as u8;
    }
    v
  }
  #[test]
  fn grade_matches_cpu_math() {
    let Some(mut chain) = chain((64, 64)) else {
      return;
    };
    stage(&mut chain, [90, 120, 150]);
    let original = pixel(&read(&chain), 64, 32, 32);
    chain.set_params(EffectParams {
      brightness: 0.2,
      ..Default::default()
    });
    let actual = pixel(&read(&chain), 64, 32, 32);
    let expected = grade(original, 0.2);
    near(actual, expected, 2);
    assert!(actual[0] > original[0]);
  }
  #[test]
  fn timeline_zoom_moves_video_edge() {
    let Some(mut chain) = chain((64, 64)) else {
      return;
    };
    stage(&mut chain, [180, 90, 60]);
    let layout = VideoLayout {
      rect: Rect {
        x: 16.0,
        y: 16.0,
        width: 32.0,
        height: 32.0,
      },
      ..VideoLayout::covering(64, 64)
    };
    chain.set_layout(layout.clone());
    let before = read(&chain);
    let region = ZoomRegion {
      start_ms: 0.0,
      end_ms: 100.0,
      level: 2.0,
      focal_x: 0.5,
      focal_y: 0.5,
      ease_duration_ms: 0.0,
      focal_keyframes: vec![],
    };
    let track = ZoomTrack::new(vec![region]);
    let expected = track.state_at(50.0, layout.rect).apply(layout.rect);
    chain.set_zoom_track(track);
    chain.stage_timeline(0, 50.0);
    let x = expected.x.max(0.0) as u32 + 3;
    let y = 32;
    assert!(x < layout.rect.x as u32);
    let after = read(&chain);
    near(pixel(&before, 64, x, y), [0, 0, 0], 1);
    near(pixel(&after, 64, x, y), [180, 90, 60], 3);
  }
}
