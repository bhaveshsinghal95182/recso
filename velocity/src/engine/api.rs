//! The napi surface for the GPU video engine.
//!
//! Everything JS can touch lives here. The modules underneath do not know napi
//! exists, which keeps the Windows code testable from `cargo test` and keeps
//! the class wrappers thin enough to read in one pass.

use super::composite::{CursorSample, FitMode, OverlayShape, Rect, WebcamLayout};
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
