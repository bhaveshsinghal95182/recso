//! The napi surface for the GPU video engine.
//!
//! Everything JS can touch lives here. The modules underneath do not know napi
//! exists, which keeps the Windows code testable from `cargo test` and keeps
//! the class wrappers thin enough to read in one pass.

use super::composite::{CursorSample, OverlayShape, Rect, WebcamLayout};
use super::{d3d, decode, encode, exporter, pattern, player, render};

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
    self
      .inner
      .seek((ms * 10_000.0) as i64)
      .map_err(win_err)
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
  out.push(format!("active: {}", d3d::active_adapter().map_err(win_err)?));
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
  pub fn new(
    path: String,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
  ) -> Result<Self> {
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12;

    let gpu = d3d::gpu().map_err(win_err)?;
    let inner =
      encode::Encoder::create(&path, width, height, fps, 1, bitrate).map_err(win_err)?;
    let source =
      d3d::create_texture(gpu, width, height, DXGI_FORMAT_NV12).map_err(win_err)?;

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
    self
      .inner
      .write_texture(&self.source, 0)
      .map_err(win_err)?;

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
  /// Defaults to 1.
  pub opacity: Option<f64>,
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

/// One recorded pointer position, normalised against the source video.
#[napi(object)]
pub struct CursorPoint {
  pub timestamp_ms: f64,
  /// 0..1 across the source frame.
  pub x: f64,
  pub y: f64,
  /// Defaults to true. A hidden sample hides the cursor until the next one.
  pub visible: Option<bool>,
}

/// What to open, when a recording is more than one file.
#[napi(object)]
pub struct PlayerSources {
  pub path: String,
  /// The camera sidecar, if the recording has one. A file that fails to open is
  /// reported through `hasWebcam()` rather than failing the whole player.
  pub webcam_path: Option<String>,
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
    let inner = player::Player::open_with_webcam(&sources.path, sources.webcam_path.as_deref())
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
    self.inner.set_webcam_layout(WebcamLayout {
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
    });
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

  /// Set the cursor bitmap.
  ///
  /// `pixels` is tightly packed RGBA8. The hotspot is where the pointer's tip
  /// actually is within the image -- without it an arrow lands below and right
  /// of the place that was clicked. Pass `None` to remove the cursor.
  #[napi]
  pub fn set_cursor_image(&self, image: Option<CursorBitmap>) -> Result<()> {
    let image = match image {
      None => {
        self.inner.set_cursor_image(None);
        return Ok(());
      }
      Some(image) => image,
    };

    let expected = image.width as usize * image.height as usize * 4;
    if image.pixels.len() < expected {
      return Err(Error::from_reason(format!(
        "cursor bitmap is {} bytes, expected {} for {}x{} RGBA",
        image.pixels.len(),
        expected,
        image.width,
        image.height
      )));
    }

    self.inner.set_cursor_image(Some(player::CursorImage {
      width: image.width,
      height: image.height,
      pixels: image.pixels.to_vec(),
      hotspot_x: image.hotspot_x.unwrap_or(0.0) as f32,
      hotspot_y: image.hotspot_y.unwrap_or(0.0) as f32,
    }));

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
    self.inner.set_cursor_track(
      samples
        .into_iter()
        .map(|point| CursorSample {
          timestamp_ms: point.timestamp_ms,
          x: point.x as f32,
          y: point.y as f32,
          visible: point.visible.unwrap_or(true),
        })
        .collect(),
    );
  }

  /// Cursor height in destination pixels, and its opacity. Size 0 hides it.
  #[napi]
  pub fn set_cursor_style(&self, size: f64, opacity: f64) {
    self.inner.set_cursor_style(size as f32, opacity as f32);
  }

  /// Adjust the render layer. Applies to preview immediately, and the exporter
  /// runs the same chain, so it applies to output too.
  #[napi]
  pub fn set_effects(&self, brightness: f64, contrast: f64, saturation: f64) {
    self.inner.set_effects(render::EffectParams {
      brightness: brightness as f32,
      contrast: contrast as f32,
      saturation: saturation as f32,
    });
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

#[napi(object)]
pub struct ExportOptions {
  pub output: String,
  /// Target bitrate in bits per second.
  pub bitrate: f64,
  /// Milliseconds. Defaults to the whole file.
  pub start: Option<f64>,
  pub end: Option<f64>,
  /// Render settings. Pass whatever the preview is currently showing.
  pub brightness: Option<f64>,
  pub contrast: Option<f64>,
  pub saturation: Option<f64>,
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
  pub fn new(input: String, options: ExportOptions) -> Self {
    Self {
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
      }),
    }
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
