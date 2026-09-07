//! The napi surface for the GPU video engine.
//!
//! Everything JS can touch lives here. The modules underneath do not know napi
//! exists, which keeps the Windows code testable from `cargo test` and keeps
//! the class wrappers thin enough to read in one pass.

use super::composite::{CursorSample, FitMode, OverlayShape, Rect, WebcamLayout, WebcamShadow};
use super::{audio, cuts, d3d, decode, encode, exporter, pattern, player, render, zoom};

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Sanity check that the addon loaded at all.
#[napi]
pub fn engine_version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

/// Everything Electron's `importSharedTexture` needs, in the shape it wants.
///
/// `handle` is the raw NT HANDLE as 8 little-endian bytes. It is only valid in
/// the process that created it -- which is the Electron main process, because
/// that is where this addon is loaded.
#[napi(object)]
pub struct SharedTextureInfo {
  /// Raw NT HANDLE as a number.
  ///
  /// Not a Buffer: the preview path runs at display rate, and allocating an
  /// external buffer per frame put V8 GC pauses (seen up to 54ms) on the UI
  /// thread. Handles are small and there are only as many as the pool has
  /// slots, so the main process caches one Buffer per value instead.
  pub handle: f64,
  /// Full allocated size of the texture.
  pub width: u32,
  pub height: u32,
  /// The meaningful sub-rectangle. Decoders pad to macroblock alignment, so this
  /// is often smaller than the coded size.
  pub visible_width: u32,
  pub visible_height: u32,
  /// One of `bgra` | `rgba` | `rgbaf16` | `nv12`.
  pub pixel_format: String,
  /// Microseconds, surfaced on the resulting `VideoFrame`.
  pub timestamp: f64,
}

#[cfg(windows)]
fn win_err(e: windows::core::Error) -> napi::Error {
  napi::Error::from_reason(format!("{} (hr=0x{:08X})", e.message(), e.code().0 as u32))
}

#[cfg(windows)]
impl SharedTextureInfo {
  fn from_texture(tex: &d3d::SharedTexture, timestamp_micros: f64) -> Self {
    Self {
      handle: tex.handle_bits() as f64,
      width: tex.width,
      height: tex.height,
      visible_width: tex.width,
      visible_height: tex.height,
      pixel_format: tex.pixel_format_name().to_string(),
      timestamp: timestamp_micros,
    }
  }
}

// ---------------------------------------------------------------------------
// Test 1: a D3D11-generated image, shared into Electron.
// ---------------------------------------------------------------------------

/// Owns a D3D11 device and one BGRA texture, and hands out its shared handle.
///
/// The texture must outlive every `VideoFrame` Electron builds from it, which is
/// why this is a class the JS side holds rather than a fire-and-forget function.
#[cfg(windows)]
#[napi]
pub struct TestPatternSource {
  texture: d3d::SharedTexture,
  frame: u32,
}

#[cfg(windows)]
#[napi]
impl TestPatternSource {
  #[napi(constructor)]
  pub fn new(width: u32, height: u32) -> Result<Self> {
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

    let gpu = d3d::gpu().map_err(win_err)?;
    let pixels = pattern::test_pattern_bgra(width, height, 0);

    // BGRA => Sharing::Plain. Electron rejects a keyed mutex on non-NV12 formats.
    let texture = d3d::SharedTexture::new(
      &gpu,
      width,
      height,
      DXGI_FORMAT_B8G8R8A8_UNORM,
      d3d::Sharing::Plain,
      Some(&pixels),
    )
    .map_err(win_err)?;

    Ok(Self { texture, frame: 0 })
  }

  /// Repaint the texture in place and return its info.
  ///
  /// No keyed mutex here (Electron forbids one for BGRA), so a repaint racing a
  /// GPU-process read can tear. Fine for a prototype; a real pipeline would use
  /// a ring of textures instead of one.
  #[napi]
  pub fn render(&mut self) -> Result<SharedTextureInfo> {
    self.frame = self.frame.wrapping_add(1);
    let pixels = pattern::test_pattern_bgra(self.texture.width, self.texture.height, self.frame);

    let gpu = d3d::gpu().map_err(win_err)?;
    unsafe {
      gpu.context.UpdateSubresource(
        &self.texture.texture,
        0,
        None,
        pixels.as_ptr() as *const _,
        self.texture.width * 4,
        0,
      );
      gpu.context.Flush();
    }

    Ok(SharedTextureInfo::from_texture(
      &self.texture,
      self.frame as f64 * 16_666.0,
    ))
  }

  /// The current texture without touching its contents.
  #[napi]
  pub fn texture_info(&self) -> SharedTextureInfo {
    SharedTextureInfo::from_texture(&self.texture, self.frame as f64 * 16_666.0)
  }
}

// ---------------------------------------------------------------------------
// Test 2: real H.264 hardware decode into a shared texture.
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct VideoInfo {
  pub width: u32,
  pub height: u32,
  pub coded_width: u32,
  pub coded_height: u32,
  /// Milliseconds.
  pub duration: f64,
  /// Frames per second as the container reports it (24000/1001 -> 23.976).
  pub fps: f64,
}

#[napi(object)]
pub struct FrameResult {
  pub end_of_stream: bool,
  /// Milliseconds into the file.
  pub timestamp: f64,
  pub frames_decoded: f64,
  /// Wall-clock cost of decode + GPU copy for this frame, in ms.
  pub decode_ms: f64,
  pub texture: Option<SharedTextureInfo>,
}

/// Opens a video file and decodes it on the GPU, one frame at a time.
#[cfg(windows)]
#[napi]
pub struct VideoDecoder {
  inner: decode::Decoder,
}

#[cfg(windows)]
#[napi]
impl VideoDecoder {
  #[napi(constructor)]
  pub fn new(path: String) -> Result<Self> {
    let inner = decode::Decoder::open(&path).map_err(win_err)?;
    Ok(Self { inner })
  }

  #[napi]
  pub fn info(&self) -> VideoInfo {
    let (cw, ch) = self.inner.coded_size();
    VideoInfo {
      width: self.inner.display_width,
      height: self.inner.display_height,
      coded_width: cw,
      coded_height: ch,
      duration: self.inner.duration_100ns as f64 / 10_000.0,
      fps: self.inner.fps_num as f64 / self.inner.fps_den.max(1) as f64,
    }
  }

  /// Decode the next frame into the shared texture and describe it.
  #[napi]
  pub fn next_frame(&mut self) -> Result<FrameResult> {
    let started = std::time::Instant::now();
    let frame = self.inner.next_frame().map_err(win_err)?;
    let decode_ms = started.elapsed().as_secs_f64() * 1000.0;

    let timestamp_micros = frame.timestamp_100ns as f64 / 10.0;
    let (cw, ch) = self.inner.coded_size();

    let texture = if frame.end_of_stream {
      None
    } else {
      Some(SharedTextureInfo {
        handle: self.inner.target.handle_bits() as f64,
        width: cw,
        height: ch,
        visible_width: self.inner.display_width,
        visible_height: self.inner.display_height,
        pixel_format: self.inner.target.pixel_format_name().to_string(),
        timestamp: timestamp_micros,
      })
    };

    Ok(FrameResult {
      end_of_stream: frame.end_of_stream,
      timestamp: frame.timestamp_100ns as f64 / 10_000.0,
      frames_decoded: self.inner.frames_decoded as f64,
      decode_ms,
      texture,
    })
  }

  /// Seek to a millisecond offset. Lands on the preceding keyframe.
  #[napi]
  pub fn seek(&mut self, ms: f64) -> Result<()> {
    self.inner.seek((ms * 10_000.0) as i64).map_err(win_err)
  }
}

#[napi(object)]
pub struct ProbeResult {
  pub opened: bool,
  pub error: String,
  pub native_types: Vec<String>,
}

/// Diagnostic: what does Media Foundation see in this file?
#[cfg(windows)]
/// What a file's audio track looks like, if it has one.
#[napi(object)]
pub struct AudioProbe {
  /// False when the file has no audio, or none that can be decoded. Not an
  /// error: a recording with the microphone off is still a recording.
  pub has_audio: bool,
  pub sample_rate: u32,
  pub channels: u32,
  /// Milliseconds.
  pub duration: f64,
}

/// Look at a file's audio without decoding all of it.
///
/// Exists mostly so an export can be checked for the track it was supposed to
/// write: `probeVideo` enumerates video stream types only, so it reports
/// nothing about sound and an audio regression would pass it silently.
#[napi]
pub fn probe_audio(path: String) -> AudioProbe {
  match audio::AudioDecoder::open(&path) {
    Ok(Some(decoder)) => AudioProbe {
      has_audio: true,
      sample_rate: decoder.sample_rate,
      channels: decoder.channels,
      duration: decoder.duration_100ns as f64 / 10_000.0,
    },
    _ => AudioProbe {
      has_audio: false,
      sample_rate: 0,
      channels: 0,
      duration: 0.0,
    },
  }
}

#[napi]
pub fn probe_video(path: String) -> ProbeResult {
  let p = decode::probe(&path);
  ProbeResult {
    opened: p.opened,
    error: p.error,
    native_types: p.native_types,
  }
}

/// Diagnostic: which decoder MFTs exist for H.264 and HEVC on this machine?
#[cfg(windows)]
#[napi]
pub fn list_decoders() -> Vec<String> {
  let mut out = Vec::new();
  for name in decode::list_decoders(decode::h264_subtype()) {
    out.push(format!("h264: {}", name));
  }
  for name in decode::list_decoders(decode::hevc_subtype()) {
    out.push(format!("hevc: {}", name));
  }
  out
}

/// Diagnostic: which GPUs exist, and which one are we actually running on?
#[cfg(windows)]
#[napi]
pub fn adapter_info() -> Result<Vec<String>> {
  let mut out = d3d::list_adapters().map_err(win_err)?;
  out.extend(d3d::gpu_preference_report());
  out.push(format!(
    "RECSO_ENGINE_GPU={}",
    std::env::var("RECSO_ENGINE_GPU").unwrap_or_else(|_| "auto (follows power policy)".into())
  ));
  out.push(format!(
    "active: {}",
    d3d::active_adapter().map_err(win_err)?
  ));
  Ok(out)
}

/// Diagnostic: what can the GPU itself decode, independent of Media Foundation?
#[cfg(windows)]
#[napi]
pub fn gpu_decoder_profiles() -> Result<Vec<String>> {
  decode::gpu_decoder_profiles().map_err(win_err)
}

// ---------------------------------------------------------------------------
// Test 3: D3D11 texture -> hardware encoder -> H.264 -> MP4.
// ---------------------------------------------------------------------------

/// Encodes generated NV12 frames to an MP4. Standalone proof of the second half
/// of the pipeline, before wiring it to a real decoder.
#[cfg(windows)]
#[napi]
pub struct PatternEncoder {
  inner: encode::Encoder,
  source: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
  frame: u32,
}

#[cfg(windows)]
#[napi]
impl PatternEncoder {
  #[napi(constructor)]
  pub fn new(path: String, width: u32, height: u32, fps: u32, bitrate: u32) -> Result<Self> {
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12;

    let gpu = d3d::gpu().map_err(win_err)?;
    let inner = encode::Encoder::create(&path, width, height, fps, 1, bitrate).map_err(win_err)?;
    let source = d3d::create_texture(gpu, width, height, DXGI_FORMAT_NV12).map_err(win_err)?;

    Ok(Self {
      inner,
      source,
      frame: 0,
    })
  }

  /// Generate one frame, upload it, and submit it to the encoder.
  #[napi]
  pub fn write_frame(&mut self) -> Result<f64> {
    let gpu = d3d::gpu().map_err(win_err)?;
    let pixels = pattern::test_pattern_nv12(self.inner.width, self.inner.height, self.frame);
    self.frame += 1;

    let started = std::time::Instant::now();
    unsafe {
      // NV12 is one subresource: Y plane then UV plane, both at row pitch = width.
      gpu.context.UpdateSubresource(
        &self.source,
        0,
        None,
        pixels.as_ptr() as *const _,
        self.inner.width,
        0,
      );
    }
    self.inner.write_texture(&self.source, 0).map_err(win_err)?;

    Ok(started.elapsed().as_secs_f64() * 1000.0)
  }

  #[napi]
  pub fn frames_written(&self) -> f64 {
    self.inner.frames_written as f64
  }

  /// Finalise the MP4. Skipping this leaves a file with no moov atom.
  #[napi]
  pub fn finish(&mut self) -> Result<()> {
    self.inner.finish().map_err(win_err)
  }
}

// ---------------------------------------------------------------------------
// Test 4: the full loop -- one decode feeding both preview and encoder.
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct PipelineStep {
  pub end_of_stream: bool,
  /// Milliseconds into the source.
  pub timestamp: f64,
  pub frames_decoded: f64,
  pub frames_encoded: f64,
  pub decode_ms: f64,
  pub encode_ms: f64,
  /// Present when preview was requested and a frame was produced.
  pub texture: Option<SharedTextureInfo>,
}

#[napi(object)]
pub struct GpuMemory {
  /// Bytes of local (on-GPU) memory this process is using.
  pub used: f64,
  /// What the OS is willing to give us right now.
  pub budget: f64,
}

/// Decode once, fan out to preview and/or encoder.
///
/// The point of Test 4: a single decoded texture serves both consumers without
/// ever leaving the GPU.
#[cfg(windows)]
#[napi]
pub struct Pipeline {
  decoder: decode::Decoder,
  encoder: Option<encode::Encoder>,
}

#[cfg(windows)]
#[napi]
impl Pipeline {
  #[napi(constructor)]
  pub fn new(input: String) -> Result<Self> {
    let decoder = decode::Decoder::open(&input).map_err(win_err)?;
    Ok(Self {
      decoder,
      encoder: None,
    })
  }

  #[napi]
  pub fn info(&self) -> VideoInfo {
    let (cw, ch) = self.decoder.coded_size();
    VideoInfo {
      width: self.decoder.display_width,
      height: self.decoder.display_height,
      coded_width: cw,
      coded_height: ch,
      duration: self.decoder.duration_100ns as f64 / 10_000.0,
      fps: self.decoder.fps_num as f64 / self.decoder.fps_den.max(1) as f64,
    }
  }

  #[napi]
  pub fn start_export(&mut self, output: String, fps: u32, bitrate: u32) -> Result<()> {
    let enc = encode::Encoder::create(
      &output,
      self.decoder.display_width,
      self.decoder.display_height,
      fps,
      1,
      bitrate,
    )
    .map_err(win_err)?;
    self.encoder = Some(enc);
    Ok(())
  }

  /// Advance one frame.
  ///
  /// `preview` controls whether a shared-texture handle comes back;
  /// `encode` controls whether the frame is also submitted to the encoder.
  #[napi]
  pub fn step(&mut self, preview: bool, encode: bool) -> Result<PipelineStep> {
    let t0 = std::time::Instant::now();
    let frame = self.decoder.next_frame().map_err(win_err)?;
    let decode_ms = t0.elapsed().as_secs_f64() * 1000.0;

    if frame.end_of_stream {
      return Ok(PipelineStep {
        end_of_stream: true,
        timestamp: frame.timestamp_100ns as f64 / 10_000.0,
        frames_decoded: self.decoder.frames_decoded as f64,
        frames_encoded: self.encoder.as_ref().map_or(0, |e| e.frames_written) as f64,
        decode_ms,
        encode_ms: 0.0,
        texture: None,
      });
    }

    let mut encode_ms = 0.0;
    if encode {
      if let Some(enc) = self.encoder.as_mut() {
        let t1 = std::time::Instant::now();
        // Hold the keyed mutex across the copy into the encoder's ring, so the
        // GPU process cannot be mid-read of the same texture.
        let _guard = self.decoder.target.lock().map_err(win_err)?;
        enc
          .write_texture(&self.decoder.target.texture, 0)
          .map_err(win_err)?;
        encode_ms = t1.elapsed().as_secs_f64() * 1000.0;
      }
    }

    let (cw, ch) = self.decoder.coded_size();
    let texture = if preview {
      Some(SharedTextureInfo {
        handle: self.decoder.target.handle_bits() as f64,
        width: cw,
        height: ch,
        visible_width: self.decoder.display_width,
        visible_height: self.decoder.display_height,
        pixel_format: self.decoder.target.pixel_format_name().to_string(),
        timestamp: frame.timestamp_100ns as f64 / 10.0,
      })
    } else {
      None
    };

    Ok(PipelineStep {
      end_of_stream: false,
      timestamp: frame.timestamp_100ns as f64 / 10_000.0,
      frames_decoded: self.decoder.frames_decoded as f64,
      frames_encoded: self.encoder.as_ref().map_or(0, |e| e.frames_written) as f64,
      decode_ms,
      encode_ms,
      texture,
    })
  }

  #[napi]
  pub fn seek(&mut self, ms: f64) -> Result<()> {
    self.decoder.seek((ms * 10_000.0) as i64).map_err(win_err)
  }

  #[napi]
  pub fn finish_export(&mut self) -> Result<f64> {
    match self.encoder.as_mut() {
      Some(e) => {
        e.finish().map_err(win_err)?;
        Ok(e.frames_written as f64)
      }
      None => Ok(0.0),
    }
  }
}

/// GPU-side memory usage, so a scrub test can show whether textures leak.
#[cfg(windows)]
#[napi]
pub fn gpu_memory() -> Result<GpuMemory> {
  let (used, budget) = d3d::video_memory().map_err(win_err)?;
  Ok(GpuMemory {
    used: used as f64,
    budget: budget as f64,
  })
}

// ---------------------------------------------------------------------------
// Player: the real thing. Threaded decode, texture pool, clock, exact seek.
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct PlayerStats {
  /// Frames decoded ahead and waiting to be presented.
  pub queue_depth: u32,
  pub decoded: f64,
  /// Frames that came due late and were skipped to keep time.
  pub dropped: f64,
  /// Samples the decoder produced with no texture, and frames the render layer
  /// refused. Both should stay at zero; anything else is a silent frame loss.
  pub skipped_no_texture: f64,
  pub skipped_render_error: f64,
  /// Worst microseconds `tick` spent waiting on the frame queue lock.
  pub max_queue_wait_us: f64,
  pub avg_decode_ms: f64,
  pub last_seek_ms: f64,
  /// Frames the last seek decoded forward -- the GOP cost of exactness.
  pub last_seek_decoded: u32,
  pub end_of_stream: bool,
  pub playing: bool,
  /// Playhead in milliseconds, from the engine clock.
  pub current_time: f64,
  pub rate: f64,
}

#[napi(object)]
pub struct PresentedFrame {
  pub texture: SharedTextureInfo,
  /// Presentation timestamp of this frame, in milliseconds.
  pub pts: f64,
}

/// A colour as four 0..1 channels.
///
/// Not a CSS string: the shader wants floats, and parsing `#rrggbb` in Rust to
/// hand back the numbers the caller already had is a conversion nobody needs.
/// The JS side has the colour as a string and one place that turns it into
/// this.
#[napi(object)]
pub struct Colour {
  pub r: f64,
  pub g: f64,
  pub b: f64,
  /// Defaults to 1.
  pub a: Option<f64>,
}

impl Colour {
  fn to_array(&self) -> [f32; 4] {
    [
      (self.r as f32).clamp(0.0, 1.0),
      (self.g as f32).clamp(0.0, 1.0),
      (self.b as f32).clamp(0.0, 1.0),
      (self.a.unwrap_or(1.0) as f32).clamp(0.0, 1.0),
    ]
  }
}

fn colour_or(colour: Option<&Colour>, fallback: [f32; 4]) -> [f32; 4] {
  colour.map(Colour::to_array).unwrap_or(fallback)
}

/// Where the recording sits on the canvas.
///
/// Canvas pixels, resolved by the caller — the padding fraction, the scale and
/// the centring stay on the JS side next to the webcam's anchor grid, so there
/// is one layout formula in the app rather than two that have to agree.
#[napi(object)]
pub struct VideoPlacement {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  /// Corner radius in canvas pixels. Defaults to 0.
  pub corner_radius: Option<f64>,
  /// Border thickness, drawn outside the rect. Defaults to 0.
  pub border_width: Option<f64>,
  pub border_colour: Option<Colour>,
}

impl From<VideoPlacement> for render::VideoLayout {
  fn from(placement: VideoPlacement) -> Self {
    render::VideoLayout {
      rect: Rect {
        x: placement.x as f32,
        y: placement.y as f32,
        width: placement.width as f32,
        height: placement.height as f32,
      },
      corner_radius: placement.corner_radius.unwrap_or(0.0) as f32,
      border_width: placement.border_width.unwrap_or(0.0) as f32,
      border_colour: colour_or(placement.border_colour.as_ref(), [0.0, 0.0, 0.0, 1.0]),
    }
  }
}

/// What fills the canvas behind the video.
///
/// Gradients and patterns arrive as `image`, already rasterised. The editor's
/// backgrounds are all static for a whole export, so letting the caller draw
/// one to a canvas and upload the pixels beats reimplementing four generators
/// in HLSL that would then have to match the Canvas2D versions exactly.
#[napi(object)]
pub struct BackgroundSpec {
  /// Flat fill, and what shows through a transparent image. Defaults to black.
  pub colour: Option<Colour>,
  /// Tightly packed RGBA8, stretched over the canvas.
  pub image: Option<CursorBitmap>,
}

/// Where the webcam overlay sits, in the screen recording's own pixels.
#[napi(object)]
pub struct WebcamOverlay {
  pub x: f64,
  pub y: f64,
  /// Zero width or height hides the overlay, and costs nothing to render.
  pub width: f64,
  pub height: f64,
  /// `rect` (default) or `ellipse`.
  pub shape: Option<String>,
  /// Corner radius in pixels. Ignored for an ellipse.
  pub corner_radius: Option<f64>,
  /// Clamped to 0..1. Defaults to 1.
  pub opacity: Option<f64>,
  /// How a camera whose aspect ratio does not match the box is reconciled:
  /// `cover` (default) crops it, `contain` letterboxes it inside the box,
  /// `stretch` distorts it to fill exactly.
  ///
  /// Only pass `stretch` if the box was computed from the camera's own aspect
  /// ratio, because nothing here will notice when it was not.
  pub fit: Option<String>,
  /// Border thickness in canvas pixels, drawn outside the box. Defaults to 0.
  pub border_width: Option<f64>,
  pub border_colour: Option<Colour>,
  /// Drop shadows under the camera, drawn in the order given. Empty is none.
  pub shadows: Option<Vec<WebcamShadowLayer>>,
}

/// One drop shadow under the camera.
///
/// The same four numbers a CSS box-shadow carries, because the editor's webcam
/// styles are authored as shadow stacks and this is where they arrive.
#[napi(object)]
pub struct WebcamShadowLayer {
  /// Canvas pixels, positive right and down. Default 0.
  pub offset_x: Option<f64>,
  pub offset_y: Option<f64>,
  /// Canvas's `shadowBlur`: a Gaussian of sigma = blur/2. Default 0, which is a
  /// hard offset silhouette rather than nothing.
  pub blur: Option<f64>,
  /// A fully transparent shadow is dropped rather than drawn.
  pub colour: Option<Colour>,
}

impl From<WebcamShadowLayer> for WebcamShadow {
  fn from(shadow: WebcamShadowLayer) -> Self {
    WebcamShadow {
      offset: [
        shadow.offset_x.unwrap_or(0.0) as f32,
        shadow.offset_y.unwrap_or(0.0) as f32,
      ],
      blur: shadow.blur.unwrap_or(0.0) as f32,
      colour: colour_or(shadow.colour.as_ref(), [0.0, 0.0, 0.0, 0.0]),
    }
  }
}

impl From<WebcamOverlay> for WebcamLayout {
  fn from(layout: WebcamOverlay) -> Self {
    WebcamLayout {
      rect: Rect {
        x: layout.x as f32,
        y: layout.y as f32,
        width: layout.width as f32,
        height: layout.height as f32,
      },
      shape: if layout.shape.as_deref() == Some("ellipse") {
        OverlayShape::Ellipse
      } else {
        OverlayShape::Rect
      },
      corner_radius: layout.corner_radius.unwrap_or(0.0) as f32,
      opacity: layout.opacity.unwrap_or(1.0) as f32,
      fit: layout
        .fit
        .as_deref()
        .map(FitMode::parse)
        .unwrap_or_default(),
      border_width: layout.border_width.unwrap_or(0.0) as f32,
      border_colour: colour_or(layout.border_colour.as_ref(), [0.0, 0.0, 0.0, 1.0]),
      shadows: layout
        .shadows
        .unwrap_or_default()
        .into_iter()
        .map(WebcamShadow::from)
        .collect(),
    }
    // Ranges enforced on the way in rather than trusted: an opacity above 1
    // multiplies into the blend's source alpha and burns the overlay's edge
    // instead of doing nothing.
    .sanitized()
  }
}

/// A cursor bitmap: tightly packed RGBA8, plus where its point actually is.
#[napi(object)]
pub struct CursorBitmap {
  pub width: u32,
  pub height: u32,
  pub pixels: Buffer,
  /// The pointer's tip within the image, in image pixels. An arrow is usually
  /// (0, 0); a crosshair or I-beam is centred.
  pub hotspot_x: Option<f64>,
  pub hotspot_y: Option<f64>,
}

impl CursorBitmap {
  /// Validate the buffer and convert. The length check is the whole point: a
  /// short buffer would be read past the end on upload.
  fn into_image(self) -> Result<player::CursorImage> {
    let expected = self.width as usize * self.height as usize * 4;
    if self.pixels.len() < expected {
      return Err(Error::from_reason(format!(
        "cursor bitmap is {} bytes, expected {} for {}x{} RGBA",
        self.pixels.len(),
        expected,
        self.width,
        self.height
      )));
    }

    Ok(player::CursorImage {
      width: self.width,
      height: self.height,
      pixels: self.pixels.to_vec(),
      hotspot_x: self.hotspot_x.unwrap_or(0.0) as f32,
      hotspot_y: self.hotspot_y.unwrap_or(0.0) as f32,
    })
  }
}

/// One recorded pointer position, normalised against the source video.
#[napi(object)]
pub struct CursorPoint {
  pub timestamp_ms: f64,
  /// 0..1 across the source frame.
  pub x: f64,
  pub y: f64,
  /// Defaults to true. A hidden sample hides the cursor until the next one.
  pub visible: Option<bool>,
  /// Which bitmap this sample wore, as an index into `setCursorImages`.
  ///
  /// An index rather than the image because a recording holds thousands of
  /// samples and a handful of shapes. Dedupe on the way in -- hash the pixels
  /// or the source data URL -- and send each distinct bitmap once.
  ///
  /// Omitted, or past the end of the table, draws the default pointer.
  pub image_id: Option<u32>,
  /// Whether the user clicked here. Defaults to false.
  ///
  /// Rides on the sample rather than arriving as its own list so a cut that
  /// drops the moment drops the click with it, and so there is one thing to
  /// keep in timeline order instead of two.
  pub click: Option<bool>,
}

/// What a click does to the pointer, and how far it stretches when it moves.
///
/// Both off when omitted, so a caller that does not care about either keeps the
/// plain pointer rather than having to switch them off.
#[napi(object)]
pub struct CursorEffectSpec {
  /// Peak scale of the click pop, taken about the hotspot so the tip stays on
  /// the pixel that was clicked. 1, or omitted, disables it.
  pub click_scale: Option<f64>,
  /// How long that pop lasts. Defaults to 0, which also disables it.
  pub click_duration_ms: Option<f64>,
  /// How far the pointer stretches along its travel, as a multiplier on the
  /// distance it actually covered. 0, or omitted, disables the smear.
  ///
  /// The length is capped at a few times the pointer's height however fast it
  /// moves -- speed has no upper bound and a smear does.
  pub smear_strength: Option<f64>,
}

impl From<CursorEffectSpec> for render::CursorEffects {
  fn from(spec: CursorEffectSpec) -> Self {
    render::CursorEffects {
      click_scale: spec.click_scale.unwrap_or(1.0) as f32,
      click_duration_ms: spec.click_duration_ms.unwrap_or(0.0),
      smear_strength: spec.smear_strength.unwrap_or(0.0) as f32,
    }
  }
}

impl From<CursorPoint> for CursorSample {
  fn from(point: CursorPoint) -> Self {
    CursorSample {
      timestamp_ms: point.timestamp_ms,
      x: point.x as f32,
      y: point.y as f32,
      visible: point.visible.unwrap_or(true),
      image_id: point.image_id,
      click: point.click.unwrap_or(false),
    }
  }
}

/// One file contributing sound to the export.
#[napi(object)]
pub struct AudioSource {
  pub path: String,
  /// Milliseconds to shift this file by so it sits on the screen recording's
  /// clock. A camera sidecar that started late has a positive offset.
  pub offset_ms: Option<f64>,
}

/// One span where the camera changes size, or takes the whole frame.
///
/// `rect` is the camera's box while this region is fully in effect, already
/// laid out by the caller. The engine eases between rectangles rather than
/// recomputing one from a height ratio, because the placement formula -- the
/// anchor grid, the margin, the aspect fit -- lives in the editor on purpose,
/// and a second copy of it is how a camera ends up one size in the preview and
/// another in the export.
#[napi(object)]
pub struct WebcamZoomRegionSpec {
  pub start_ms: f64,
  pub end_ms: f64,
  /// Milliseconds of smoothstep at each end. 0 snaps.
  pub ease_duration_ms: f64,
  /// Where the camera sits while this region is held.
  pub rect: VideoPlacement,
  /// Whether the camera expands to the whole canvas over this span, dissolving
  /// its corner radius and border as it goes.
  pub full_screen: Option<bool>,
}

impl From<WebcamZoomRegionSpec> for zoom::WebcamZoomRegion {
  fn from(spec: WebcamZoomRegionSpec) -> Self {
    zoom::WebcamZoomRegion {
      start_ms: spec.start_ms,
      end_ms: spec.end_ms,
      ease_duration_ms: spec.ease_duration_ms,
      rect: Rect {
        x: spec.rect.x as f32,
        y: spec.rect.y as f32,
        width: spec.rect.width as f32,
        height: spec.rect.height as f32,
      },
      full_screen: spec.full_screen.unwrap_or(false),
    }
  }
}

/// A focal point a zoom pans to while it is held.
#[napi(object)]
pub struct ZoomFocalKeyframe {
  pub timestamp_ms: f64,
  /// 0..1 across the recording, not the canvas.
  pub x: f64,
  pub y: f64,
}

/// One span of the timeline that is zoomed in.
#[napi(object)]
pub struct ZoomRegion {
  pub start_ms: f64,
  pub end_ms: f64,
  /// 1 is no zoom.
  pub zoom_level: f64,
  /// Where it zooms to, 0..1 across the recording. Mapped through the video's
  /// placement, so a zoom stays on its subject when the video is inset.
  pub focal_x: f64,
  pub focal_y: f64,
  /// How long the ease in and the ease out each take. 0 snaps.
  pub ease_duration_ms: Option<f64>,
  /// Extra focal points to pan between while the zoom is held.
  pub focal_keyframes: Option<Vec<ZoomFocalKeyframe>>,
}

impl From<ZoomRegion> for zoom::ZoomRegion {
  fn from(region: ZoomRegion) -> Self {
    zoom::ZoomRegion {
      start_ms: region.start_ms,
      end_ms: region.end_ms,
      level: region.zoom_level as f32,
      focal_x: region.focal_x as f32,
      focal_y: region.focal_y as f32,
      ease_duration_ms: region.ease_duration_ms.unwrap_or(0.0),
      focal_keyframes: region
        .focal_keyframes
        .unwrap_or_default()
        .into_iter()
        .map(|point| zoom::FocalKeyframe {
          timestamp_ms: point.timestamp_ms,
          x: point.x as f32,
          y: point.y as f32,
        })
        .collect(),
    }
  }
}

/// How much of each edge of the recording to throw away.
///
/// Fractions of the visible frame rather than pixels, so a crop survives the
/// recording being scaled. Cropping does not resize anything: the kept region is
/// stretched across whatever rect `setLayout` was given, so a crop that changes
/// the aspect ratio wants a matching rect.
#[napi(object)]
pub struct SourceCropSpec {
  pub top: f64,
  pub left: f64,
  pub bottom: f64,
  pub right: f64,
}

impl From<SourceCropSpec> for render::SourceCrop {
  fn from(spec: SourceCropSpec) -> Self {
    render::SourceCrop {
      top: spec.top as f32,
      left: spec.left as f32,
      bottom: spec.bottom as f32,
      right: spec.right as f32,
    }
  }
}

/// A span of the recording to leave out.
///
/// In *source* time -- where it sits in the file. Everything the player reports
/// afterwards, its duration and playhead included, is in composition time:
/// where things sit in the resulting edit.
#[napi(object)]
pub struct CutRegion {
  pub start_ms: f64,
  pub end_ms: f64,
}

impl From<CutRegion> for cuts::Cut {
  fn from(region: CutRegion) -> Self {
    cuts::Cut {
      start_ms: region.start_ms,
      end_ms: region.end_ms,
    }
  }
}

/// What to open, when a recording is more than one file.
#[napi(object)]
pub struct PlayerSources {
  pub path: String,
  /// The camera sidecar, if the recording has one. A file that fails to open is
  /// reported through `hasWebcam()` rather than failing the whole player.
  pub webcam_path: Option<String>,
  /// The canvas to compose onto. Defaults to the recording's own visible size.
  ///
  /// Fixed for the life of the player: these are the dimensions of the textures
  /// handed to Chromium, and changing them means re-importing every handle.
  /// Inset the video with `setLayout` instead — that moves freely.
  pub canvas_width: Option<u32>,
  pub canvas_height: Option<u32>,
}

#[cfg(windows)]
#[napi]
pub struct VideoPlayer {
  inner: player::Player,
}

#[cfg(windows)]
#[napi]
impl VideoPlayer {
  #[napi(constructor)]
  pub fn new(path: String) -> Result<Self> {
    let inner = player::Player::open(&path).map_err(win_err)?;
    Ok(Self { inner })
  }

  /// Open a recording that has more than one video file.
  ///
  /// The camera is a second decoder on the same thread, not a second player:
  /// one clock, with the camera pulled to whatever timestamp the screen frame
  /// has. Two players would each own a clock and the two would drift.
  #[napi(factory)]
  pub fn open(sources: PlayerSources) -> Result<Self> {
    let canvas = match (sources.canvas_width, sources.canvas_height) {
      (Some(width), Some(height)) => Some((width, height)),
      _ => None,
    };
    let inner =
      player::Player::open_with_webcam(&sources.path, sources.webcam_path.as_deref(), canvas)
        .map_err(win_err)?;
    Ok(Self { inner })
  }

  #[napi]
  pub fn info(&self) -> VideoInfo {
    let s = self.inner.shared();
    VideoInfo {
      width: s.width,
      height: s.height,
      coded_width: s.coded_width,
      coded_height: s.coded_height,
      duration: s.duration_ms,
      fps: s.fps_num as f64 / s.fps_den.max(1) as f64,
    }
  }

  /// Every texture in the pool, so the app can force the GPU process to import
  /// them all up front. Skipping this shows up as a ~450ms stall partway
  /// through the first second of playback.
  #[napi]
  pub fn pool_textures(&self) -> Vec<SharedTextureInfo> {
    let s = self.inner.shared();
    s.pool_handles
      .iter()
      .map(|bits| SharedTextureInfo {
        handle: *bits as f64,
        width: s.coded_width,
        height: s.coded_height,
        visible_width: s.width,
        visible_height: s.height,
        pixel_format: "bgra".to_string(),
        timestamp: 0.0,
      })
      .collect()
  }

  #[napi]
  pub fn play(&self) {
    self.inner.set_playing(true);
  }

  #[napi]
  pub fn pause(&self) {
    self.inner.set_playing(false);
  }

  #[napi]
  pub fn set_rate(&self, rate: f64) {
    self.inner.set_rate(rate);
  }

  /// Seek to a millisecond offset. Returns immediately; the decode thread does
  /// the work and `tick` produces the frame once it lands.
  ///
  /// `exact` decodes forward to the frame covering `ms`, which costs a GOP.
  /// Pass `false` while dragging a scrubber and `true` when it is released.
  #[napi]
  pub fn seek(&self, ms: f64, exact: Option<bool>) {
    let mode = if exact.unwrap_or(true) {
      player::SeekMode::Exact
    } else {
      player::SeekMode::Fast
    };
    self.inner.seek(ms, mode);
  }

  /// Ask for the frame that should be on screen now.
  ///
  /// Returns `None` when the current frame is still the right one, which is the
  /// normal case whenever the display refreshes faster than the video.
  #[napi]
  pub fn tick(&self) -> Option<PresentedFrame> {
    self.inner.tick().map(|f| PresentedFrame {
      pts: f.pts_ms,
      texture: SharedTextureInfo {
        handle: f.handle_bits as f64,
        width: f.coded_width,
        height: f.coded_height,
        visible_width: f.visible_width,
        visible_height: f.visible_height,
        // The render layer outputs BGRA, and Electron wants no keyed mutex on
        // bgra handles.
        pixel_format: "bgra".to_string(),
        timestamp: f.pts_ms * 1000.0,
      },
    })
  }

  /// Place the webcam overlay.
  ///
  /// Coordinates are in the screen recording's own pixels, so the caller
  /// resolves the anchor grid and size ratios and passes the result -- keeping
  /// one placement formula in the app rather than two that have to agree.
  ///
  /// Applies to preview immediately and re-renders the frames already queued,
  /// so dragging the box stays responsive. The exporter runs the same chain, so
  /// it applies to output too.
  #[napi]
  pub fn set_webcam_layout(&self, layout: WebcamOverlay) {
    self.inner.set_webcam_layout(layout.into());
  }

  /// Whether this player has a camera track at all.
  #[napi]
  pub fn has_webcam(&self) -> bool {
    self.inner.has_webcam()
  }

  /// The composited frame currently on screen, as BGRA bytes.
  ///
  /// Includes everything the render layer does -- grading, the webcam box, the
  /// cursor -- because it reads back the finished frame rather than any
  /// intermediate. Length is `codedWidth * codedHeight * 4`.
  ///
  /// Stalls the GPU. For stills and verification, not for playback.
  #[napi]
  pub fn snapshot_bgra(&self) -> Option<Buffer> {
    self.inner.snapshot_bgra().map(Buffer::from)
  }

  /// Pointer samples the decode thread has loaded.
  ///
  /// Set asynchronously, so this reads zero for a moment after
  /// `setCursorTrack`. Mostly here to tell an empty track apart from a cursor
  /// that is simply positioned offscreen.
  #[napi]
  pub fn cursor_sample_count(&self) -> f64 {
    self.inner.cursor_sample_count() as f64
  }

  /// How many pointer bitmaps `setCursorImages` left resident. Asynchronous
  /// like the sample count, and zero for a moment after the call.
  #[napi]
  pub fn cursor_image_count(&self) -> f64 {
    self.inner.cursor_image_count() as f64
  }

  /// Set the cursor bitmap.
  ///
  /// `pixels` is tightly packed RGBA8. The hotspot is where the pointer's tip
  /// actually is within the image -- without it an arrow lands below and right
  /// of the place that was clicked. Pass `None` to remove the cursor.
  /// The pointer bitmaps this recording used, indexed by `CursorPoint.imageId`.
  ///
  /// Replaces the whole table. Uploaded once, so a long recording costs the
  /// same as a short one: it is the number of distinct shapes that matters,
  /// not the number of samples.
  #[napi]
  pub fn set_cursor_images(&self, images: Vec<CursorBitmap>) -> Result<()> {
    let images = images
      .into_iter()
      .map(CursorBitmap::into_image)
      .collect::<Result<Vec<_>>>()?;
    self.inner.set_cursor_images(images);
    Ok(())
  }

  #[napi]
  pub fn set_cursor_image(&self, image: Option<CursorBitmap>) -> Result<()> {
    self
      .inner
      .set_cursor_image(image.map(CursorBitmap::into_image).transpose()?);
    Ok(())
  }

  /// Set the recorded pointer path.
  ///
  /// Positions are normalised 0..1 against the source video so they survive it
  /// being scaled. The cursor holds the last sample rather than interpolating
  /// between them: the pointer does not move between reports, and smoothing
  /// would invent motion that never happened.
  #[napi]
  pub fn set_cursor_track(&self, samples: Vec<CursorPoint>) {
    self
      .inner
      .set_cursor_track(samples.into_iter().map(CursorSample::from).collect());
  }

  /// Spans where the camera changes size, or expands to the whole frame.
  ///
  /// Each carries the box the camera sits in while that region is held; the
  /// engine eases between that and the one `setWebcamLayout` gave it.
  #[napi]
  pub fn set_webcam_zoom_regions(&self, regions: Vec<WebcamZoomRegionSpec>) {
    self.inner.set_webcam_zoom_regions(
      regions
        .into_iter()
        .map(zoom::WebcamZoomRegion::from)
        .collect(),
    );
  }

  /// Which layer sits on top of which, bottom first.
  ///
  /// Names as the editor uses them. `background` is accepted and ignored, being
  /// the canvas rather than a layer, and anything omitted keeps its default
  /// position -- a list from a newer project should reorder what this build
  /// knows about rather than refusing to draw.
  #[napi]
  pub fn set_layer_order(&self, order: Vec<String>) {
    self.inner.set_layer_order(render::parse_layer_order(&order));
  }

  /// Spans of the composition to leave the camera out of, in composition time.
  ///
  /// Separate from `setCuts`, which removes time from the timeline entirely.
  /// These stretches still play; the camera is simply not in them.
  #[napi]
  pub fn set_webcam_cuts(&self, spans: Vec<CutRegion>) {
    self.inner.set_webcam_cuts(
      spans
        .into_iter()
        .map(|region| (region.start_ms, region.end_ms))
        .collect(),
    );
  }

  /// Cursor height in destination pixels, and its opacity. Size 0 hides it.
  #[napi]
  pub fn set_cursor_style(&self, size: f64, opacity: f64) {
    self.inner.set_cursor_style(size as f32, opacity as f32);
  }

  /// The click pop and the smear.
  ///
  /// Apart from `setCursorStyle` because those two describe the pointer and
  /// these describe its motion: they are resolved per frame against the track,
  /// so a click needs `click: true` on the samples and a smear needs enough of
  /// them to measure a speed from.
  #[napi]
  pub fn set_cursor_effects(&self, effects: CursorEffectSpec) {
    self.inner.set_cursor_effects(effects.into());
  }

  /// Set the zoom/pan timeline.
  ///
  /// The video and the cursor move with it; the background and the webcam do
  /// not, because a zoom is about the recording and the camera box is furniture
  /// on top of it.
  #[napi]
  pub fn set_zoom_regions(&self, regions: Vec<ZoomRegion>) {
    self
      .inner
      .set_zoom_regions(regions.into_iter().map(zoom::ZoomRegion::from).collect());
  }

  /// Zoom regions the decode thread has loaded. Applied asynchronously, so this
  /// reads 0 for a moment after `setZoomRegions`.
  #[napi]
  pub fn zoom_region_count(&self) -> f64 {
    self.inner.zoom_region_count() as f64
  }

  /// Remove spans of the recording.
  ///
  /// Regions are in source time. Afterwards `compositionDuration` is the length
  /// of the edit rather than the file, and seeking and the playhead are in that
  /// same time -- so a cut is invisible to the caller beyond the video getting
  /// shorter.
  #[napi]
  pub fn set_cuts(&self, regions: Vec<CutRegion>) {
    self
      .inner
      .set_cuts(regions.into_iter().map(cuts::Cut::from).collect());
  }

  /// Throw away the edges of the recording. Pass `null` to keep all of it.
  #[napi]
  pub fn set_source_crop(&self, crop: Option<SourceCropSpec>) {
    self
      .inner
      .set_source_crop(crop.map(render::SourceCrop::from));
  }

  /// Cuts the decode thread has loaded. Applied asynchronously.
  #[napi]
  pub fn cut_count(&self) -> f64 {
    self.inner.cut_count() as f64
  }

  /// How long the edit runs, in milliseconds: the file's duration less whatever
  /// has been cut out of it.
  #[napi]
  pub fn composition_duration(&self) -> f64 {
    self.inner.composition_duration_ms()
  }

  /// Grade the video layer. Applies to preview immediately, and the exporter
  /// runs the same chain, so it applies to output too.
  ///
  /// The video only. The camera is a different sensor with a different
  /// exposure, so it has its own — see `setWebcamEffects`.
  #[napi]
  pub fn set_effects(&self, brightness: f64, contrast: f64, saturation: f64) {
    self.inner.set_effects(render::EffectParams {
      brightness: brightness as f32,
      contrast: contrast as f32,
      saturation: saturation as f32,
    });
  }

  /// Grade the webcam layer.
  #[napi]
  pub fn set_webcam_effects(&self, brightness: f64, contrast: f64, saturation: f64) {
    self.inner.set_webcam_effects(render::EffectParams {
      brightness: brightness as f32,
      contrast: contrast as f32,
      saturation: saturation as f32,
    });
  }

  /// Place the recording on the canvas, with an optional corner radius and
  /// border.
  ///
  /// Coordinates are canvas pixels. A rect covering the whole canvas is the
  /// default and what a project with no background wants; anything smaller
  /// leaves room for the background to show.
  #[napi]
  pub fn set_layout(&self, placement: VideoPlacement) {
    self.inner.set_layout(placement.into());
  }

  /// Set what fills the canvas behind the video.
  #[napi]
  pub fn set_background(&self, background: BackgroundSpec) -> Result<()> {
    self.inner.set_background(build_background(background)?);
    Ok(())
  }

  #[napi]
  pub fn stats(&self) -> PlayerStats {
    let s = self.inner.stats();
    PlayerStats {
      queue_depth: s.queue_depth,
      decoded: s.decoded as f64,
      dropped: s.dropped as f64,
      skipped_no_texture: s.skipped_no_texture as f64,
      skipped_render_error: s.skipped_render_error as f64,
      max_queue_wait_us: s.max_queue_wait_us as f64,
      avg_decode_ms: s.avg_decode_ms,
      last_seek_ms: s.last_seek_ms,
      last_seek_decoded: s.last_seek_decoded,
      end_of_stream: s.end_of_stream,
      playing: s.playing,
      current_time: s.current_time_ms,
      rate: s.rate,
    }
  }

  /// Stop the decode thread and release the texture pool.
  #[napi]
  pub fn close(&mut self) {
    self.inner.close();
  }
}

// ---------------------------------------------------------------------------
// Exporter: decode -> render -> encode -> MP4, on its own thread.
// ---------------------------------------------------------------------------

/// What to export, and everything the preview is showing on top of it.
///
/// The overlay fields are not optional extras: an export that leaves them out
/// is not the video the user approved, because the preview draws them. They are
/// separate from the player's setters because the exporter builds its own chain
/// on its own thread -- there is nothing to inherit from.
#[napi(object)]
pub struct ExportOptions {
  pub output: String,
  /// Target bitrate in bits per second.
  pub bitrate: f64,
  /// Milliseconds. Defaults to the whole file.
  pub start: Option<f64>,
  pub end: Option<f64>,
  /// The video layer's grade. Pass whatever the preview is currently showing.
  pub brightness: Option<f64>,
  pub contrast: Option<f64>,
  pub saturation: Option<f64>,
  /// The webcam layer's own grade.
  pub webcam_brightness: Option<f64>,
  pub webcam_contrast: Option<f64>,
  pub webcam_saturation: Option<f64>,
  /// The canvas to compose onto. Defaults to the recording's visible size.
  pub canvas_width: Option<u32>,
  pub canvas_height: Option<u32>,
  /// Where the recording sits on that canvas. Defaults to filling it.
  pub layout: Option<VideoPlacement>,
  /// What is behind the video. Only visible if `layout` insets it.
  pub background: Option<BackgroundSpec>,
  /// The camera sidecar. Omit it and the export has no webcam overlay, however
  /// the preview looks.
  pub webcam_path: Option<String>,
  /// Where the camera goes, in the screen recording's own pixels -- the same
  /// values passed to `setWebcamLayout`.
  pub webcam: Option<WebcamOverlay>,
  /// The pointer bitmap, as passed to `setCursorImage`. Drawn for samples
  /// that do not name one of `cursorImages`.
  pub cursor: Option<CursorBitmap>,
  /// The pointer bitmap table, as passed to `setCursorImages`.
  pub cursor_images: Option<Vec<CursorBitmap>>,
  /// The recorded pointer path, as passed to `setCursorTrack`.
  pub cursor_track: Option<Vec<CursorPoint>>,
  /// The zoom/pan timeline. Omit it and the export is unzoomed, however the
  /// preview looks.
  pub zoom_regions: Option<Vec<ZoomRegion>>,
  /// Every file contributing sound. Omit it and the export is silent.
  ///
  /// Not inferred from the input and the camera sidecar: which tracks belong in
  /// the mix is an editing decision, and muting the camera should be a matter
  /// of leaving it out of this list.
  pub audio_sources: Option<Vec<AudioSource>>,
  /// Spans of the source to leave out. Omit and the whole range is exported.
  pub cuts: Option<Vec<CutRegion>>,
  /// Edges of the recording to throw away. Omit to keep all of it.
  pub crop: Option<SourceCropSpec>,
  /// Cursor height in destination pixels. Defaults to 22, matching the editor.
  pub cursor_size: Option<f64>,
  /// Clamped to 0..1. Defaults to 1.
  pub cursor_opacity: Option<f64>,
  /// The click pop and the smear. Omit and the pointer draws plainly.
  pub cursor_effects: Option<CursorEffectSpec>,
  /// Spans of the composition to leave the camera out of, in composition time.
  ///
  /// Already mapped: a span cut from the screen as well is gone from the
  /// timeline entirely, so what belongs here is only the stretches where the
  /// recording keeps playing without the camera in it.
  pub webcam_cuts: Option<Vec<CutRegion>>,
  /// Which layer sits on top of which, bottom first: "video", "webcam",
  /// "cursor". `background` is accepted and ignored -- it is the canvas rather
  /// than a layer. Anything omitted keeps its default position.
  pub layer_order: Option<Vec<String>>,
  /// Spans where the camera changes size, or expands to the whole frame.
  pub webcam_zoom_regions: Option<Vec<WebcamZoomRegionSpec>>,
}

#[napi(object)]
pub struct ExportProgress {
  pub frames_done: f64,
  /// Estimated from the range and frame rate, so treat it as approximate.
  pub frames_total: f64,
  pub finished: bool,
  pub cancelled: bool,
  pub error: Option<String>,
  pub fps: f64,
  /// Frames per second once encoding is running, excluding setup.
  pub steady_fps: f64,
  /// Time before the first frame: decoder open, shader compile, encoder init.
  pub setup_ms: f64,
  pub avg_decode_ms: f64,
  pub avg_render_ms: f64,
  pub avg_encode_ms: f64,
  pub elapsed_ms: f64,
}

/// Validate the JS-facing background and hand back the chain's request form.
///
/// No GPU work: the texture is uploaded by whichever thread renders. Shared by
/// the player and the exporter so an export cannot end up with a different
/// background from the preview it was approved in.
fn build_background(spec: BackgroundSpec) -> Result<render::BackgroundRequest> {
  let clear = colour_or(spec.colour.as_ref(), [0.0, 0.0, 0.0, 1.0]);

  let Some(image) = spec.image else {
    return Ok(render::BackgroundRequest { clear, image: None });
  };

  let expected = image.width as usize * image.height as usize * 4;
  if image.pixels.len() < expected {
    return Err(Error::from_reason(format!(
      "background image is {} bytes, expected {} for {}x{} RGBA",
      image.pixels.len(),
      expected,
      image.width,
      image.height
    )));
  }

  Ok(render::BackgroundRequest {
    clear,
    image: Some(render::RgbaImage {
      width: image.width,
      height: image.height,
      pixels: image.pixels.to_vec(),
    }),
  })
}

/// A running export. Poll `progress`; call `cancel` to stop early.
///
/// Cancelling still finalises the MP4, so the partial file is playable.
#[cfg(windows)]
#[napi]
pub struct VideoExporter {
  inner: exporter::Exporter,
}

#[cfg(windows)]
#[napi]
impl VideoExporter {
  #[napi(constructor)]
  pub fn new(input: String, options: ExportOptions) -> Result<Self> {
    // Fallible now, because a malformed cursor bitmap is worth refusing up
    // front rather than discovering as a silent missing layer minutes into an
    // export.
    let cursor_image = options.cursor.map(CursorBitmap::into_image).transpose()?;
    let cursor_images = options
      .cursor_images
      .unwrap_or_default()
      .into_iter()
      .map(CursorBitmap::into_image)
      .collect::<Result<Vec<_>>>()?;

    Ok(Self {
      inner: exporter::Exporter::start(exporter::Options {
        input,
        output: options.output,
        bitrate: options.bitrate as u32,
        start_ms: options.start.unwrap_or(0.0),
        end_ms: options.end.unwrap_or(0.0),
        effects: render::EffectParams {
          brightness: options.brightness.unwrap_or(0.0) as f32,
          contrast: options.contrast.unwrap_or(1.0) as f32,
          saturation: options.saturation.unwrap_or(1.0) as f32,
        },
        webcam_effects: render::EffectParams {
          brightness: options.webcam_brightness.unwrap_or(0.0) as f32,
          contrast: options.webcam_contrast.unwrap_or(1.0) as f32,
          saturation: options.webcam_saturation.unwrap_or(1.0) as f32,
        },
        canvas: match (options.canvas_width, options.canvas_height) {
          (Some(width), Some(height)) => Some((width, height)),
          _ => None,
        },
        layout: options.layout.map(render::VideoLayout::from),
        background: options.background.map(build_background).transpose()?,
        webcam_path: options.webcam_path,
        webcam_layout: options.webcam.map(WebcamLayout::from),
        cursor_image,
        cursor_images,
        cursor_track: options
          .cursor_track
          .unwrap_or_default()
          .into_iter()
          .map(CursorSample::from)
          .collect(),
        zoom_regions: options
          .zoom_regions
          .unwrap_or_default()
          .into_iter()
          .map(zoom::ZoomRegion::from)
          .collect(),
        audio_sources: options
          .audio_sources
          .unwrap_or_default()
          .into_iter()
          .map(|source| (source.path, source.offset_ms.unwrap_or(0.0)))
          .collect(),
        cuts: options
          .cuts
          .unwrap_or_default()
          .into_iter()
          .map(cuts::Cut::from)
          .collect(),
        crop: options.crop.map(render::SourceCrop::from),
        cursor_size: options.cursor_size.unwrap_or(22.0) as f32,
        cursor_opacity: options.cursor_opacity.unwrap_or(1.0).clamp(0.0, 1.0) as f32,
        cursor_effects: options
          .cursor_effects
          .map(render::CursorEffects::from)
          .unwrap_or_default(),
        webcam_cuts: options
          .webcam_cuts
          .unwrap_or_default()
          .into_iter()
          .map(|region| (region.start_ms, region.end_ms))
          .collect(),
        layer_order: options
          .layer_order
          .as_deref()
          .map(render::parse_layer_order)
          .unwrap_or(render::DEFAULT_LAYER_ORDER),
        webcam_zoom_regions: options
          .webcam_zoom_regions
          .unwrap_or_default()
          .into_iter()
          .map(zoom::WebcamZoomRegion::from)
          .collect(),
      }),
    })
  }

  #[napi]
  pub fn progress(&self) -> ExportProgress {
    let p = self.inner.progress();
    ExportProgress {
      frames_done: p.frames_done as f64,
      frames_total: p.frames_total as f64,
      finished: p.finished,
      cancelled: p.cancelled,
      error: p.error,
      fps: p.fps,
      steady_fps: p.steady_fps,
      setup_ms: p.setup_ms,
      avg_decode_ms: p.avg_decode_ms,
      avg_render_ms: p.avg_render_ms,
      avg_encode_ms: p.avg_encode_ms,
      elapsed_ms: p.elapsed_ms,
    }
  }

  #[napi]
  pub fn cancel(&self) {
    self.inner.cancel();
  }
}

#[cfg(test)]
mod colour_scenarios {
  use super::*;

  fn colour(r: f64, g: f64, b: f64, a: Option<f64>) -> Colour {
    Colour { r, g, b, a }
  }

  #[test]
  fn a_colour_crosses_the_boundary_channel_for_channel() {
    let out = colour(0.25, 0.5, 0.75, Some(0.5)).to_array();
    assert_eq!(out, [0.25, 0.5, 0.75, 0.5]);
  }

  #[test]
  fn a_missing_alpha_defaults_to_opaque() {
    // Which is what a caller sending `{ r, g, b }` means, rather than an
    // invisible colour.
    assert_eq!(colour(1.0, 0.0, 0.0, None).to_array()[3], 1.0);
  }

  #[test]
  fn every_channel_is_clamped_above() {
    let out = colour(4.0, 4.0, 4.0, Some(4.0)).to_array();
    assert_eq!(out, [1.0, 1.0, 1.0, 1.0]);
  }

  #[test]
  fn every_channel_is_clamped_below() {
    let out = colour(-4.0, -4.0, -4.0, Some(-4.0)).to_array();
    assert_eq!(out, [0.0, 0.0, 0.0, 0.0]);
  }

  #[test]
  fn a_caller_sending_bytes_rather_than_fractions_clamps_to_white() {
    // Worth pinning: nothing here rescales 0..255, so it saturates rather than
    // producing an out-of-range colour the shader would do something odd with.
    let out = colour(255.0, 128.0, 0.0, None).to_array();
    assert_eq!(out, [1.0, 1.0, 0.0, 1.0]);
  }

  #[test]
  fn the_channels_do_not_get_reordered() {
    let out = colour(0.1, 0.2, 0.3, Some(0.4)).to_array();
    assert!(out[0] < out[1] && out[1] < out[2] && out[2] < out[3]);
  }

  #[test]
  fn a_missing_colour_falls_back_to_what_the_caller_chose() {
    let fallback = [0.1, 0.2, 0.3, 0.4];
    assert_eq!(colour_or(None, fallback), fallback);
  }

  #[test]
  fn a_present_colour_wins_over_the_fallback() {
    let given = colour(1.0, 0.0, 0.0, None);
    assert_eq!(colour_or(Some(&given), [0.0, 0.0, 0.0, 1.0]), [1.0, 0.0, 0.0, 1.0]);
  }

  #[test]
  fn a_fully_transparent_colour_is_not_mistaken_for_a_missing_one() {
    let clear = colour(0.0, 0.0, 0.0, Some(0.0));
    assert_eq!(colour_or(Some(&clear), [1.0, 1.0, 1.0, 1.0]), [0.0, 0.0, 0.0, 0.0]);
  }
}

#[cfg(test)]
mod placement_conversion_scenarios {
  use super::*;

  fn placement() -> VideoPlacement {
    VideoPlacement {
      x: 40.0,
      y: 20.0,
      width: 1840.0,
      height: 1040.0,
      corner_radius: None,
      border_width: None,
      border_colour: None,
    }
  }

  #[test]
  fn the_rectangle_crosses_the_boundary_unchanged() {
    let layout: render::VideoLayout = placement().into();
    assert_eq!(layout.rect.x, 40.0);
    assert_eq!(layout.rect.y, 20.0);
    assert_eq!(layout.rect.width, 1840.0);
    assert_eq!(layout.rect.height, 1040.0);
  }

  #[test]
  fn an_omitted_corner_radius_is_no_radius() {
    let layout: render::VideoLayout = placement().into();
    assert_eq!(layout.corner_radius, 0.0);
  }

  #[test]
  fn an_omitted_border_is_no_border() {
    let layout: render::VideoLayout = placement().into();
    assert_eq!(layout.border_width, 0.0);
  }

  #[test]
  fn an_omitted_border_colour_is_opaque_black() {
    let layout: render::VideoLayout = placement().into();
    assert_eq!(layout.border_colour, [0.0, 0.0, 0.0, 1.0]);
  }

  #[test]
  fn a_given_corner_radius_and_border_come_across() {
    let layout: render::VideoLayout = VideoPlacement {
      corner_radius: Some(24.0),
      border_width: Some(3.0),
      ..placement()
    }
    .into();
    assert_eq!(layout.corner_radius, 24.0);
    assert_eq!(layout.border_width, 3.0);
  }

  #[test]
  fn a_given_border_colour_comes_across() {
    let layout: render::VideoLayout = VideoPlacement {
      border_colour: Some(Colour {
        r: 1.0,
        g: 0.5,
        b: 0.0,
        a: None,
      }),
      ..placement()
    }
    .into();
    assert_eq!(layout.border_colour, [1.0, 0.5, 0.0, 1.0]);
  }

  #[test]
  fn the_conversion_narrows_to_f32_without_losing_a_realistic_canvas() {
    // Canvas sizes are small integers; f64 -> f32 is exact well past 4K.
    let layout: render::VideoLayout = VideoPlacement {
      x: 0.0,
      y: 0.0,
      width: 3840.0,
      height: 2160.0,
      ..placement()
    }
    .into();
    assert_eq!(layout.rect.width, 3840.0);
    assert_eq!(layout.rect.height, 2160.0);
  }
}

#[cfg(test)]
mod webcam_conversion_scenarios {
  use super::*;

  fn overlay() -> WebcamOverlay {
    WebcamOverlay {
      x: 1400.0,
      y: 800.0,
      width: 400.0,
      height: 225.0,
      shape: None,
      corner_radius: None,
      opacity: None,
      fit: None,
      border_width: None,
      border_colour: None,
      shadows: None,
    }
  }

  #[test]
  fn the_box_crosses_the_boundary_unchanged() {
    let layout: WebcamLayout = overlay().into();
    assert_eq!(layout.rect.x, 1400.0);
    assert_eq!(layout.rect.width, 400.0);
  }

  #[test]
  fn the_default_shape_is_a_rectangle() {
    let layout: WebcamLayout = overlay().into();
    assert_eq!(layout.shape, OverlayShape::Rect);
  }

  #[test]
  fn an_ellipse_is_asked_for_by_name() {
    let layout: WebcamLayout = WebcamOverlay {
      shape: Some("ellipse".to_string()),
      ..overlay()
    }
    .into();
    assert_eq!(layout.shape, OverlayShape::Ellipse);
  }

  #[test]
  fn an_unknown_shape_falls_back_to_a_rectangle() {
    for name in ["circle", "Ellipse", "", "hexagon"] {
      let layout: WebcamLayout = WebcamOverlay {
        shape: Some(name.to_string()),
        ..overlay()
      }
      .into();
      assert_eq!(layout.shape, OverlayShape::Rect, "{name}");
    }
  }

  #[test]
  fn an_omitted_opacity_is_fully_opaque() {
    let layout: WebcamLayout = overlay().into();
    assert_eq!(layout.opacity, 1.0);
  }

  #[test]
  fn an_opacity_above_one_is_clamped_on_the_way_in() {
    // Above 1 multiplies into the blend's source alpha and burns the overlay's
    // feathered edge rather than doing nothing.
    let layout: WebcamLayout = WebcamOverlay {
      opacity: Some(4.0),
      ..overlay()
    }
    .into();
    assert_eq!(layout.opacity, 1.0);
  }

  #[test]
  fn a_negative_opacity_is_clamped_on_the_way_in() {
    let layout: WebcamLayout = WebcamOverlay {
      opacity: Some(-1.0),
      ..overlay()
    }
    .into();
    assert_eq!(layout.opacity, 0.0);
  }

  #[test]
  fn a_negative_corner_radius_is_refused_on_the_way_in() {
    let layout: WebcamLayout = WebcamOverlay {
      corner_radius: Some(-10.0),
      ..overlay()
    }
    .into();
    assert_eq!(layout.corner_radius, 0.0);
  }

  #[test]
  fn the_default_fit_is_the_one_that_cannot_look_wrong() {
    let layout: WebcamLayout = overlay().into();
    assert_eq!(layout.fit, FitMode::Cover);
  }

  #[test]
  fn each_fit_mode_is_reachable_by_name() {
    for (name, expected) in [
      ("cover", FitMode::Cover),
      ("contain", FitMode::Contain),
      ("stretch", FitMode::Stretch),
      ("fill", FitMode::Stretch),
    ] {
      let layout: WebcamLayout = WebcamOverlay {
        fit: Some(name.to_string()),
        ..overlay()
      }
      .into();
      assert_eq!(layout.fit, expected, "{name}");
    }
  }

  #[test]
  fn no_shadows_means_no_shadows() {
    let layout: WebcamLayout = overlay().into();
    assert!(layout.shadows.is_empty());
  }

  #[test]
  fn an_empty_shadow_list_means_no_shadows() {
    let layout: WebcamLayout = WebcamOverlay {
      shadows: Some(Vec::new()),
      ..overlay()
    }
    .into();
    assert!(layout.shadows.is_empty());
  }

  #[test]
  fn a_shadow_stack_comes_across_in_order() {
    let layout: WebcamLayout = WebcamOverlay {
      shadows: Some(vec![
        WebcamShadowLayer {
          offset_x: Some(1.0),
          offset_y: Some(1.0),
          blur: Some(2.0),
          colour: Some(Colour {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: Some(0.5),
          }),
        },
        WebcamShadowLayer {
          offset_x: Some(0.0),
          offset_y: Some(8.0),
          blur: Some(24.0),
          colour: Some(Colour {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: Some(0.3),
          }),
        },
      ]),
      ..overlay()
    }
    .into();
    assert_eq!(layout.shadows.len(), 2);
    assert_eq!(layout.shadows[0].blur, 2.0);
    assert_eq!(layout.shadows[1].blur, 24.0);
  }

  #[test]
  fn a_shadow_with_no_colour_is_transparent_and_so_dropped() {
    // The default is a fully transparent black, and `sanitized` throws those
    // away rather than paying a quad for something invisible.
    let layout: WebcamLayout = WebcamOverlay {
      shadows: Some(vec![WebcamShadowLayer {
        offset_x: Some(4.0),
        offset_y: Some(4.0),
        blur: Some(8.0),
        colour: None,
      }]),
      ..overlay()
    }
    .into();
    assert!(layout.shadows.is_empty());
  }

  #[test]
  fn a_shadow_with_no_offset_or_blur_is_dropped() {
    let layout: WebcamLayout = WebcamOverlay {
      shadows: Some(vec![WebcamShadowLayer {
        offset_x: None,
        offset_y: None,
        blur: None,
        colour: Some(Colour {
          r: 0.0,
          g: 0.0,
          b: 0.0,
          a: Some(1.0),
        }),
      }]),
      ..overlay()
    }
    .into();
    assert!(layout.shadows.is_empty());
  }

  #[test]
  fn a_shadow_layer_converts_its_four_numbers_faithfully() {
    let shadow: WebcamShadow = WebcamShadowLayer {
      offset_x: Some(-3.0),
      offset_y: Some(7.0),
      blur: Some(12.0),
      colour: Some(Colour {
        r: 0.1,
        g: 0.2,
        b: 0.3,
        a: Some(0.4),
      }),
    }
    .into();
    assert_eq!(shadow.offset, [-3.0, 7.0]);
    assert_eq!(shadow.blur, 12.0);
    assert_eq!(shadow.colour, [0.1, 0.2, 0.3, 0.4]);
  }

  #[test]
  fn an_empty_overlay_box_converts_to_something_not_visible() {
    let layout: WebcamLayout = WebcamOverlay {
      width: 0.0,
      height: 0.0,
      ..overlay()
    }
    .into();
    assert!(!layout.is_visible());
  }
}

#[cfg(test)]
mod timeline_conversion_scenarios {
  use super::*;

  #[test]
  fn a_cut_region_crosses_the_boundary_unchanged() {
    let cut: cuts::Cut = CutRegion {
      start_ms: 500.0,
      end_ms: 1500.0,
    }
    .into();
    assert_eq!(cut.start_ms, 500.0);
    assert_eq!(cut.end_ms, 1500.0);
  }

  #[test]
  fn a_crop_spec_crosses_the_boundary_unchanged() {
    let crop: render::SourceCrop = SourceCropSpec {
      top: 0.1,
      left: 0.2,
      bottom: 0.3,
      right: 0.4,
    }
    .into();
    assert_eq!(crop.top, 0.1);
    assert_eq!(crop.left, 0.2);
    assert_eq!(crop.bottom, 0.3);
    assert_eq!(crop.right, 0.4);
  }

  #[test]
  fn a_crop_spec_of_zeroes_resolves_to_no_crop() {
    let crop: render::SourceCrop = SourceCropSpec {
      top: 0.0,
      left: 0.0,
      bottom: 0.0,
      right: 0.0,
    }
    .into();
    assert_eq!(crop.resolve(), None);
  }

  #[test]
  fn a_cursor_point_crosses_the_boundary_with_its_flags() {
    let sample: CursorSample = CursorPoint {
      timestamp_ms: 1000.0,
      x: 0.25,
      y: 0.75,
      visible: Some(false),
      image_id: Some(3),
      click: Some(true),
    }
    .into();
    assert_eq!(sample.timestamp_ms, 1000.0);
    assert_eq!(sample.x, 0.25);
    assert_eq!(sample.y, 0.75);
    assert!(!sample.visible);
    assert_eq!(sample.image_id, Some(3));
    assert!(sample.click);
  }

  #[test]
  fn a_cursor_point_defaults_to_visible_and_not_clicked() {
    let sample: CursorSample = CursorPoint {
      timestamp_ms: 0.0,
      x: 0.0,
      y: 0.0,
      visible: None,
      image_id: None,
      click: None,
    }
    .into();
    assert!(sample.visible);
    assert!(!sample.click);
    assert_eq!(sample.image_id, None);
  }

  #[test]
  fn cursor_effects_default_to_both_off() {
    let effects: render::CursorEffects = CursorEffectSpec {
      click_scale: None,
      click_duration_ms: None,
      smear_strength: None,
    }
    .into();
    assert_eq!(effects, render::CursorEffects::default());
  }

  #[test]
  fn cursor_effects_come_across_when_they_are_given() {
    let effects: render::CursorEffects = CursorEffectSpec {
      click_scale: Some(1.4),
      click_duration_ms: Some(220.0),
      smear_strength: Some(0.8),
    }
    .into();
    assert_eq!(effects.click_scale, 1.4);
    assert_eq!(effects.click_duration_ms, 220.0);
    assert_eq!(effects.smear_strength, 0.8);
  }

  #[test]
  fn a_zoom_region_crosses_the_boundary_unchanged() {
    let region: zoom::ZoomRegion = ZoomRegion {
      start_ms: 1000.0,
      end_ms: 3000.0,
      zoom_level: 2.5,
      focal_x: 0.3,
      focal_y: 0.7,
      ease_duration_ms: Some(400.0),
      focal_keyframes: None,
    }
    .into();
    assert_eq!(region.start_ms, 1000.0);
    assert_eq!(region.end_ms, 3000.0);
    assert_eq!(region.level, 2.5);
    assert_eq!(region.focal_x, 0.3);
    assert_eq!(region.focal_y, 0.7);
    assert_eq!(region.ease_duration_ms, 400.0);
  }

  #[test]
  fn a_zoom_region_with_no_ease_snaps() {
    let region: zoom::ZoomRegion = ZoomRegion {
      start_ms: 0.0,
      end_ms: 1000.0,
      zoom_level: 2.0,
      focal_x: 0.5,
      focal_y: 0.5,
      ease_duration_ms: None,
      focal_keyframes: None,
    }
    .into();
    assert_eq!(region.ease_duration_ms, 0.0);
  }

  #[test]
  fn a_zoom_region_with_no_keyframes_holds_still() {
    let region: zoom::ZoomRegion = ZoomRegion {
      start_ms: 0.0,
      end_ms: 1000.0,
      zoom_level: 2.0,
      focal_x: 0.5,
      focal_y: 0.5,
      ease_duration_ms: None,
      focal_keyframes: None,
    }
    .into();
    assert!(region.focal_keyframes.is_empty());
  }

  #[test]
  fn focal_keyframes_come_across_in_order() {
    let region: zoom::ZoomRegion = ZoomRegion {
      start_ms: 0.0,
      end_ms: 1000.0,
      zoom_level: 2.0,
      focal_x: 0.0,
      focal_y: 0.0,
      ease_duration_ms: None,
      focal_keyframes: Some(vec![
        ZoomFocalKeyframe {
          timestamp_ms: 500.0,
          x: 0.5,
          y: 0.5,
        },
        ZoomFocalKeyframe {
          timestamp_ms: 900.0,
          x: 1.0,
          y: 1.0,
        },
      ]),
    }
    .into();
    assert_eq!(region.focal_keyframes.len(), 2);
    assert_eq!(region.focal_keyframes[0].timestamp_ms, 500.0);
    assert_eq!(region.focal_keyframes[1].x, 1.0);
  }

  #[test]
  fn a_webcam_zoom_region_crosses_the_boundary_unchanged() {
    let region: zoom::WebcamZoomRegion = WebcamZoomRegionSpec {
      start_ms: 1000.0,
      end_ms: 3000.0,
      ease_duration_ms: 200.0,
      rect: VideoPlacement {
        x: 10.0,
        y: 20.0,
        width: 300.0,
        height: 400.0,
        corner_radius: None,
        border_width: None,
        border_colour: None,
      },
      full_screen: None,
    }
    .into();
    assert_eq!(region.start_ms, 1000.0);
    assert_eq!(region.ease_duration_ms, 200.0);
    assert_eq!(region.rect.x, 10.0);
    assert_eq!(region.rect.height, 400.0);
  }

  #[test]
  fn a_webcam_zoom_region_is_not_full_screen_unless_asked() {
    let spec = |full_screen| WebcamZoomRegionSpec {
      start_ms: 0.0,
      end_ms: 1000.0,
      ease_duration_ms: 0.0,
      rect: VideoPlacement {
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 100.0,
        corner_radius: None,
        border_width: None,
        border_colour: None,
      },
      full_screen,
    };
    let off: zoom::WebcamZoomRegion = spec(None).into();
    assert!(!off.full_screen);
    let on: zoom::WebcamZoomRegion = spec(Some(true)).into();
    assert!(on.full_screen);
  }

  #[test]
  fn a_converted_zoom_region_behaves_the_same_as_a_hand_built_one() {
    // The conversion is the only thing between the editor's JSON and the
    // timeline, so it is worth checking end to end rather than field by field.
    let converted: zoom::ZoomRegion = ZoomRegion {
      start_ms: 1000.0,
      end_ms: 3000.0,
      zoom_level: 2.0,
      focal_x: 0.5,
      focal_y: 0.5,
      ease_duration_ms: Some(200.0),
      focal_keyframes: None,
    }
    .into();
    let track = zoom::ZoomTrack::new(vec![converted]);
    let video = Rect {
      x: 0.0,
      y: 0.0,
      width: 1000.0,
      height: 1000.0,
    };
    assert!((track.state_at(2000.0, video).scale - 2.0).abs() < 1e-5);
    assert!(track.state_at(500.0, video).is_identity());
  }

  #[test]
  fn a_converted_cut_region_maps_the_clocks_the_way_the_editor_expects() {
    let cut: cuts::Cut = CutRegion {
      start_ms: 500.0,
      end_ms: 1500.0,
    }
    .into();
    let track = cuts::CutTrack::new(vec![cut]);
    assert_eq!(track.to_composition(2000.0), 1000.0);
    assert_eq!(track.to_source(1000.0), 2000.0);
  }

  #[test]
  fn the_engine_reports_a_version() {
    let version = engine_version();
    assert!(!version.is_empty());
  }
}

#[cfg(test)]
mod boundary_matrix {
  use super::*;

  // -- colours ---------------------------------------------------------------

  const CHANNEL_VALUES: [f64; 9] = [-1e9, -1.0, -0.001, 0.0, 0.25, 0.5, 1.0, 1.001, 1e9];

  fn colour(r: f64, g: f64, b: f64, a: Option<f64>) -> Colour {
    Colour { r, g, b, a }
  }

  #[test]
  fn every_channel_value_is_clamped_into_range() {
    for value in CHANNEL_VALUES {
      let out = colour(value, value, value, Some(value)).to_array();
      for (i, channel) in out.iter().enumerate() {
        assert!((0.0..=1.0).contains(channel), "{value} channel {i}: {channel}");
        assert!(channel.is_finite(), "{value} channel {i}");
      }
    }
  }

  #[test]
  fn a_value_in_range_is_carried_across_unchanged() {
    for value in [0.0f64, 0.1, 0.25, 0.5, 0.75, 1.0] {
      let out = colour(value, value, value, Some(value)).to_array();
      for channel in out {
        assert!((channel as f64 - value).abs() < 1e-6, "{value}: {channel}");
      }
    }
  }

  #[test]
  fn the_channels_never_swap_places_for_any_combination() {
    let values = [0.1f64, 0.4, 0.7, 0.9];
    for r in values {
      for g in values {
        for b in values {
          let out = colour(r, g, b, None).to_array();
          assert!((out[0] as f64 - r).abs() < 1e-6, "{r},{g},{b}");
          assert!((out[1] as f64 - g).abs() < 1e-6, "{r},{g},{b}");
          assert!((out[2] as f64 - b).abs() < 1e-6, "{r},{g},{b}");
          assert_eq!(out[3], 1.0, "{r},{g},{b}");
        }
      }
    }
  }

  #[test]
  fn a_non_finite_channel_still_yields_a_finite_colour() {
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
      let out = colour(bad, 0.5, 0.5, Some(bad)).to_array();
      // Infinity clamps; NaN is the one `clamp` passes through, so this pins
      // which of the two the shader could ever see.
      assert!(out[1].is_finite() && out[2].is_finite(), "{bad}");
      if bad.is_infinite() {
        assert!(out[0].is_finite(), "{bad}");
        assert!(out[3].is_finite(), "{bad}");
      }
    }
  }

  #[test]
  fn a_missing_colour_always_yields_the_fallback_exactly() {
    let fallbacks = [
      [0.0f32, 0.0, 0.0, 1.0],
      [1.0, 1.0, 1.0, 1.0],
      [0.0, 0.0, 0.0, 0.0],
      [0.13, 0.42, 0.87, 0.5],
    ];
    for fallback in fallbacks {
      assert_eq!(colour_or(None, fallback), fallback, "{fallback:?}");
    }
  }

  #[test]
  fn a_present_colour_always_wins_over_any_fallback() {
    let fallbacks = [[0.0f32, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0]];
    for fallback in fallbacks {
      for value in [0.0f64, 0.5, 1.0] {
        let given = colour(value, value, value, Some(value));
        let out = colour_or(Some(&given), fallback);
        assert_eq!(out, given.to_array(), "{fallback:?} {value}");
      }
    }
  }

  // -- video placement -------------------------------------------------------

  fn placement() -> VideoPlacement {
    VideoPlacement {
      x: 0.0,
      y: 0.0,
      width: 1920.0,
      height: 1080.0,
      corner_radius: None,
      border_width: None,
      border_colour: None,
    }
  }

  #[test]
  fn a_placement_carries_its_rectangle_across_for_every_geometry() {
    let boxes = [
      (0.0f64, 0.0f64, 1920.0f64, 1080.0f64),
      (96.0, 54.0, 1728.0, 972.0),
      (-100.0, -50.0, 200.0, 100.0),
      (0.0, 0.0, 0.0, 0.0),
      (0.5, 0.25, 3840.0, 2160.0),
    ];
    for (x, y, width, height) in boxes {
      let layout: render::VideoLayout = VideoPlacement {
        x,
        y,
        width,
        height,
        ..placement()
      }
      .into();
      assert_eq!(layout.rect.x as f64, x, "{x},{y} {width}x{height}");
      assert_eq!(layout.rect.y as f64, y, "{x},{y} {width}x{height}");
      assert_eq!(layout.rect.width as f64, width, "{x},{y} {width}x{height}");
      assert_eq!(layout.rect.height as f64, height, "{x},{y} {width}x{height}");
    }
  }

  #[test]
  fn every_omitted_placement_field_takes_its_documented_default() {
    let layout: render::VideoLayout = placement().into();
    assert_eq!(layout.corner_radius, 0.0);
    assert_eq!(layout.border_width, 0.0);
    assert_eq!(layout.border_colour, [0.0, 0.0, 0.0, 1.0]);
  }

  #[test]
  fn every_supplied_placement_field_is_carried_across() {
    for radius in [0.0f64, 1.0, 24.0, 999.0] {
      for border in [0.0f64, 1.0, 6.0, 100.0] {
        let layout: render::VideoLayout = VideoPlacement {
          corner_radius: Some(radius),
          border_width: Some(border),
          ..placement()
        }
        .into();
        assert_eq!(layout.corner_radius as f64, radius, "{radius}/{border}");
        assert_eq!(layout.border_width as f64, border, "{radius}/{border}");
      }
    }
  }

  // -- webcam overlay --------------------------------------------------------

  fn overlay() -> WebcamOverlay {
    WebcamOverlay {
      x: 100.0,
      y: 100.0,
      width: 384.0,
      height: 216.0,
      shape: None,
      corner_radius: None,
      opacity: None,
      fit: None,
      border_width: None,
      border_colour: None,
      shadows: None,
    }
  }

  #[test]
  fn every_omitted_overlay_field_takes_its_documented_default() {
    let layout: WebcamLayout = overlay().into();
    assert_eq!(layout.shape, OverlayShape::Rect);
    assert_eq!(layout.corner_radius, 0.0);
    assert_eq!(layout.opacity, 1.0);
    assert_eq!(layout.fit, FitMode::Cover);
    assert_eq!(layout.border_width, 0.0);
    assert_eq!(layout.border_colour, [0.0, 0.0, 0.0, 1.0]);
    assert!(layout.shadows.is_empty());
  }

  #[test]
  fn every_shape_name_resolves_the_same_way_every_time() {
    let names = [
      ("ellipse", OverlayShape::Ellipse),
      ("rect", OverlayShape::Rect),
      ("Ellipse", OverlayShape::Rect),
      ("ELLIPSE", OverlayShape::Rect),
      (" ellipse", OverlayShape::Rect),
      ("circle", OverlayShape::Rect),
      ("", OverlayShape::Rect),
    ];
    for (name, expected) in names {
      let layout: WebcamLayout = WebcamOverlay {
        shape: Some(name.to_string()),
        ..overlay()
      }
      .into();
      assert_eq!(layout.shape, expected, "{name:?}");
    }
  }

  #[test]
  fn every_fit_name_resolves_the_same_way_every_time() {
    let names = [
      ("cover", FitMode::Cover),
      ("contain", FitMode::Contain),
      ("stretch", FitMode::Stretch),
      ("fill", FitMode::Stretch),
      ("Cover", FitMode::Cover),
      ("", FitMode::Cover),
      ("crop", FitMode::Cover),
    ];
    for (name, expected) in names {
      let layout: WebcamLayout = WebcamOverlay {
        fit: Some(name.to_string()),
        ..overlay()
      }
      .into();
      assert_eq!(layout.fit, expected, "{name:?}");
    }
  }

  #[test]
  fn the_overlay_is_sanitised_on_the_way_in_for_every_opacity() {
    for opacity in [-1e9f64, -1.0, 0.0, 0.5, 1.0, 1.001, 1e9] {
      let layout: WebcamLayout = WebcamOverlay {
        opacity: Some(opacity),
        ..overlay()
      }
      .into();
      assert!(
        (0.0..=1.0).contains(&layout.opacity),
        "{opacity}: {}",
        layout.opacity
      );
    }
  }

  #[test]
  fn the_overlay_is_sanitised_on_the_way_in_for_every_radius_and_border() {
    for value in [-1e9f64, -1.0, 0.0, 12.0, 1e9] {
      let layout: WebcamLayout = WebcamOverlay {
        corner_radius: Some(value),
        border_width: Some(value),
        ..overlay()
      }
      .into();
      assert!(layout.corner_radius >= 0.0, "{value}");
      assert!(layout.border_width >= 0.0, "{value}");
    }
  }

  #[test]
  fn a_shadow_layer_takes_its_documented_defaults_for_every_omitted_field() {
    let shadow: WebcamShadow = WebcamShadowLayer {
      offset_x: None,
      offset_y: None,
      blur: None,
      colour: None,
    }
    .into();
    assert_eq!(shadow.offset, [0.0, 0.0]);
    assert_eq!(shadow.blur, 0.0);
    // A fully transparent black, which `sanitized` then drops.
    assert_eq!(shadow.colour, [0.0, 0.0, 0.0, 0.0]);
    assert!(!shadow.is_visible());
  }

  #[test]
  fn a_shadow_layer_carries_every_supplied_field_across() {
    for offset_x in [-20.0f64, 0.0, 12.0] {
      for offset_y in [-20.0f64, 0.0, 12.0] {
        for blur in [0.0f64, 4.0, 40.0] {
          let shadow: WebcamShadow = WebcamShadowLayer {
            offset_x: Some(offset_x),
            offset_y: Some(offset_y),
            blur: Some(blur),
            colour: Some(Colour {
              r: 0.0,
              g: 0.0,
              b: 0.0,
              a: Some(0.5),
            }),
          }
          .into();
          assert_eq!(shadow.offset[0] as f64, offset_x);
          assert_eq!(shadow.offset[1] as f64, offset_y);
          assert_eq!(shadow.blur as f64, blur);
          assert_eq!(shadow.colour[3], 0.5);
        }
      }
    }
  }

  #[test]
  fn only_the_shadows_that_would_draw_survive_the_boundary() {
    // Every combination of "has an offset" and "has a blur" and "has alpha".
    for offset in [0.0f64, 6.0] {
      for blur in [0.0f64, 12.0] {
        for alpha in [0.0f64, 0.5] {
          let layout: WebcamLayout = WebcamOverlay {
            shadows: Some(vec![WebcamShadowLayer {
              offset_x: Some(offset),
              offset_y: Some(0.0),
              blur: Some(blur),
              colour: Some(Colour {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: Some(alpha),
              }),
            }]),
            ..overlay()
          }
          .into();
          let should_draw = alpha > 0.0 && (blur > 0.0 || offset != 0.0);
          assert_eq!(
            layout.shadows.len(),
            usize::from(should_draw),
            "offset {offset} blur {blur} alpha {alpha}"
          );
        }
      }
    }
  }

  #[test]
  fn a_shadow_stack_keeps_its_order_across_the_boundary() {
    for count in 1..6usize {
      let shadows: Vec<WebcamShadowLayer> = (0..count)
        .map(|i| WebcamShadowLayer {
          offset_x: Some(0.0),
          offset_y: Some(0.0),
          blur: Some((i + 1) as f64 * 5.0),
          colour: Some(Colour {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: Some(0.5),
          }),
        })
        .collect();
      let layout: WebcamLayout = WebcamOverlay {
        shadows: Some(shadows),
        ..overlay()
      }
      .into();
      assert_eq!(layout.shadows.len(), count, "{count} shadows");
      for (i, s) in layout.shadows.iter().enumerate() {
        assert_eq!(s.blur as f64, (i + 1) as f64 * 5.0, "{count} shadows at {i}");
      }
    }
  }

  // -- cursor ---------------------------------------------------------------

  #[test]
  fn every_omitted_cursor_field_takes_its_documented_default() {
    let sample: CursorSample = CursorPoint {
      timestamp_ms: 0.0,
      x: 0.0,
      y: 0.0,
      visible: None,
      image_id: None,
      click: None,
    }
    .into();
    assert!(sample.visible);
    assert!(!sample.click);
    assert_eq!(sample.image_id, None);
  }

  #[test]
  fn every_cursor_flag_combination_survives_the_boundary() {
    for visible in [None, Some(true), Some(false)] {
      for click in [None, Some(true), Some(false)] {
        for image_id in [None, Some(0u32), Some(7)] {
          let sample: CursorSample = CursorPoint {
            timestamp_ms: 1_000.0,
            x: 0.25,
            y: 0.75,
            visible,
            image_id,
            click,
          }
          .into();
          assert_eq!(sample.visible, visible.unwrap_or(true), "{visible:?}");
          assert_eq!(sample.click, click.unwrap_or(false), "{click:?}");
          assert_eq!(sample.image_id, image_id, "{image_id:?}");
          assert_eq!(sample.timestamp_ms, 1_000.0);
        }
      }
    }
  }

  #[test]
  fn cursor_effects_default_to_off_and_carry_every_supplied_value() {
    let off: render::CursorEffects = CursorEffectSpec {
      click_scale: None,
      click_duration_ms: None,
      smear_strength: None,
    }
    .into();
    assert_eq!(off, render::CursorEffects::default());

    for scale in [0.5f64, 1.0, 1.5, 3.0] {
      for duration in [0.0f64, 100.0, 250.0] {
        for smear in [0.0f64, 0.5, 2.0] {
          let on: render::CursorEffects = CursorEffectSpec {
            click_scale: Some(scale),
            click_duration_ms: Some(duration),
            smear_strength: Some(smear),
          }
          .into();
          assert_eq!(on.click_scale as f64, scale, "{scale}/{duration}/{smear}");
          assert_eq!(on.click_duration_ms, duration, "{scale}/{duration}/{smear}");
          assert_eq!(on.smear_strength as f64, smear, "{scale}/{duration}/{smear}");
        }
      }
    }
  }

  // -- timeline -------------------------------------------------------------

  #[test]
  fn every_cut_region_crosses_the_boundary_unchanged() {
    let spans = [
      (0.0f64, 1_000.0f64),
      (5_000.0, 8_000.0),
      (-500.0, 1_000.0),
      (1_000.0, 1_000.0),
      (2_000.0, 1_000.0),
    ];
    for (start_ms, end_ms) in spans {
      let cut: cuts::Cut = CutRegion { start_ms, end_ms }.into();
      assert_eq!(cut.start_ms, start_ms, "{start_ms}..{end_ms}");
      assert_eq!(cut.end_ms, end_ms, "{start_ms}..{end_ms}");
    }
  }

  #[test]
  fn a_list_of_cut_regions_normalises_the_way_the_editor_expects() {
    // The boundary is a plain copy; normalisation happens in `CutTrack::new`,
    // and the two together are what the caller actually gets.
    let regions = vec![
      CutRegion { start_ms: 2_000.0, end_ms: 1_000.0 },
      CutRegion { start_ms: 5_000.0, end_ms: 8_000.0 },
      CutRegion { start_ms: 1_000.0, end_ms: 1_000.0 },
      CutRegion { start_ms: -500.0, end_ms: 500.0 },
    ];
    let track = cuts::CutTrack::new(regions.into_iter().map(cuts::Cut::from).collect());
    assert_eq!(track.len(), 2);
    assert!(track.contains(0.0));
    assert!(track.contains(6_000.0));
  }

  #[test]
  fn every_crop_spec_crosses_the_boundary_unchanged() {
    // To f32 precision: the crop is fractions of a frame, so the narrowing
    // costs about seven significant figures and nothing that matters.
    let edges = [0.0f64, 0.1, 0.5, 0.95, 1.0, -1.0];
    for top in edges {
      for left in edges {
        let crop: render::SourceCrop = SourceCropSpec {
          top,
          left,
          bottom: 0.0,
          right: 0.0,
        }
        .into();
        assert!((crop.top as f64 - top).abs() < 1e-6, "{top}/{left}");
        assert!((crop.left as f64 - left).abs() < 1e-6, "{top}/{left}");
        assert_eq!(crop.bottom, 0.0);
        assert_eq!(crop.right, 0.0);
      }
    }
  }

  #[test]
  fn the_boundary_narrows_to_f32_and_that_is_all_it_does() {
    // JavaScript numbers are f64 and the render layer is f32, so every value
    // crossing loses precision at about the seventh significant figure. Worth
    // pinning: it is the reason a test on this boundary compares to a
    // tolerance rather than exactly, and the reason a caller cannot use these
    // fields to carry anything but a coordinate.
    let crop: render::SourceCrop = SourceCropSpec {
      top: 0.1,
      left: 0.0,
      bottom: 0.0,
      right: 0.0,
    }
    .into();
    assert_eq!(crop.top, 0.1f32);
    assert_ne!(crop.top as f64, 0.1f64);
    assert!((crop.top as f64 - 0.1f64).abs() < 1e-7);
  }

  #[test]
  fn a_canvas_sized_value_crosses_the_boundary_exactly() {
    // Pixel coordinates are small integers, which f32 represents exactly well
    // past any canvas anyone will use.
    for value in [0.0f64, 1.0, 720.0, 1080.0, 1920.0, 2160.0, 3840.0, 7680.0] {
      let layout: render::VideoLayout = VideoPlacement {
        x: value,
        y: value,
        width: value,
        height: value,
        corner_radius: Some(value),
        border_width: Some(value),
        border_colour: None,
      }
      .into();
      assert_eq!(layout.rect.x as f64, value, "{value}");
      assert_eq!(layout.rect.width as f64, value, "{value}");
      assert_eq!(layout.corner_radius as f64, value, "{value}");
    }
  }

  #[test]
  fn every_zoom_region_carries_its_numbers_across() {
    for level in [0.5f64, 1.0, 2.0, 4.0] {
      for ease in [None, Some(0.0), Some(400.0)] {
        let region: zoom::ZoomRegion = ZoomRegion {
          start_ms: 1_000.0,
          end_ms: 3_000.0,
          zoom_level: level,
          focal_x: 0.25,
          focal_y: 0.75,
          ease_duration_ms: ease,
          focal_keyframes: None,
        }
        .into();
        assert_eq!(region.level as f64, level, "{level}/{ease:?}");
        assert_eq!(region.ease_duration_ms, ease.unwrap_or(0.0), "{level}/{ease:?}");
        assert_eq!(region.focal_x, 0.25);
        assert_eq!(region.focal_y, 0.75);
        assert_eq!(region.start_ms, 1_000.0);
        assert_eq!(region.end_ms, 3_000.0);
      }
    }
  }

  #[test]
  fn focal_keyframes_survive_the_boundary_for_every_count() {
    for count in 0..6usize {
      let keyframes: Vec<ZoomFocalKeyframe> = (0..count)
        .map(|i| ZoomFocalKeyframe {
          timestamp_ms: 1_000.0 + i as f64 * 100.0,
          x: i as f64 / 10.0,
          y: 1.0 - i as f64 / 10.0,
        })
        .collect();
      let region: zoom::ZoomRegion = ZoomRegion {
        start_ms: 1_000.0,
        end_ms: 3_000.0,
        zoom_level: 2.0,
        focal_x: 0.5,
        focal_y: 0.5,
        ease_duration_ms: None,
        focal_keyframes: if count == 0 { None } else { Some(keyframes) },
      }
      .into();
      assert_eq!(region.focal_keyframes.len(), count, "{count} keyframes");
      for (i, k) in region.focal_keyframes.iter().enumerate() {
        assert_eq!(k.timestamp_ms, 1_000.0 + i as f64 * 100.0, "{count} at {i}");
      }
    }
  }

  #[test]
  fn every_webcam_zoom_region_carries_its_box_and_flag_across() {
    for full in [None, Some(false), Some(true)] {
      for ease in [0.0f64, 200.0, 900.0] {
        let region: zoom::WebcamZoomRegion = WebcamZoomRegionSpec {
          start_ms: 1_000.0,
          end_ms: 3_000.0,
          ease_duration_ms: ease,
          rect: VideoPlacement {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 400.0,
            corner_radius: None,
            border_width: None,
            border_colour: None,
          },
          full_screen: full,
        }
        .into();
        assert_eq!(region.full_screen, full.unwrap_or(false), "{full:?}/{ease}");
        assert_eq!(region.ease_duration_ms, ease, "{full:?}/{ease}");
        assert_eq!(region.rect.x, 10.0);
        assert_eq!(region.rect.height, 400.0);
      }
    }
  }

  #[test]
  fn a_converted_project_behaves_the_same_as_a_hand_built_one() {
    // The boundary is the only thing between the editor's JSON and the
    // timeline, so it is worth driving end to end rather than field by field.
    let cut: cuts::Cut = CutRegion {
      start_ms: 5_000.0,
      end_ms: 8_000.0,
    }
    .into();
    let cuts = cuts::CutTrack::new(vec![cut]);
    let region: zoom::ZoomRegion = ZoomRegion {
      start_ms: 10_000.0,
      end_ms: 12_000.0,
      zoom_level: 2.0,
      focal_x: 0.5,
      focal_y: 0.5,
      ease_duration_ms: Some(0.0),
      focal_keyframes: None,
    }
    .into();
    let zooms = zoom::ZoomTrack::new(vec![region]);
    let video = Rect {
      x: 0.0,
      y: 0.0,
      width: 1920.0,
      height: 1080.0,
    };

    // Source 13s is composition 10s, which is where the zoom starts.
    assert_eq!(cuts.to_composition(13_000.0), 10_000.0);
    assert_eq!(zooms.state_at(10_000.0, video).scale, 2.0);
    assert!(zooms.state_at(cuts.to_composition(4_000.0), video).is_identity());
  }

  #[test]
  fn the_engine_reports_a_version_that_looks_like_one() {
    let version = engine_version();
    assert!(!version.is_empty());
    assert!(version.is_ascii(), "{version}");
  }
}
