//! The Linux napi surface mirrors the shared Windows declarations.
//!
//! Decode stays in software here. Texture fields remain optional until the
//! separate GPU player is available, so Electron can identify that boundary.

use super::{audio, exporter, media::VideoSource, thumbnails, player};
use crate::capture::linux::encoder::EncoderChoice;
use crate::engine::{cuts, scene, zoom};
use crate::engine::layout::{CursorSample, FitMode, OverlayShape, Rect, Shadow, WebcamLayout};
use crate::engine::sheet::{SheetBudget, SheetPlan};
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn engine_version() -> String {
  format!("{} velocity-linux-software", env!("CARGO_PKG_VERSION"))
}

/// The same shape as on Windows, so the typings are identical. On Linux a
/// frame travels as a single-plane DMA-BUF: `handle` is unused and the
/// `dmabuf_*` fields describe it for Electron's `nativePixmap` import.
#[napi(object)]
#[derive(Default, Clone)]
pub struct SharedTextureInfo {
  pub handle: f64,
  pub width: u32,
  pub height: u32,
  pub visible_width: u32,
  pub visible_height: u32,
  pub pixel_format: String,
  pub timestamp: f64,
  pub dmabuf_fd: Option<i32>,
  pub dmabuf_stride: Option<u32>,
  pub dmabuf_offset: Option<u32>,
  pub dmabuf_size: Option<u32>,
  /// The GBM format modifier as a decimal string; a u64 does not fit a JS number.
  pub dmabuf_modifier: Option<String>,
}

#[napi(object)]
pub struct VideoInfo {
  pub width: u32,
  pub height: u32,
  pub coded_width: u32,
  pub coded_height: u32,
  pub duration: f64,
  pub fps: f64,
}

#[napi(object)]
pub struct FrameResult {
  pub end_of_stream: bool,
  pub timestamp: f64,
  pub frames_decoded: f64,
  pub decode_ms: f64,
  pub texture: Option<SharedTextureInfo>,
}

/// Owns a sequential software decoder for one local recording.
#[napi]
pub struct VideoDecoder {
  inner: VideoSource,
  frames_decoded: u64,
  last_timestamp: f64,
}

#[napi]
impl VideoDecoder {
  #[napi(constructor)]
  pub fn new(path: String) -> Result<Self> {
    Ok(Self { inner: VideoSource::open(&path).map_err(Error::from_reason)?,
      frames_decoded: 0, last_timestamp: 0.0 })
  }

  #[napi]
  pub fn info(&self) -> VideoInfo {
    let info = self.inner.info();
    VideoInfo { width: info.width, height: info.height,
      coded_width: info.coded_width, coded_height: info.coded_height,
      duration: info.duration_ms, fps: info.fps }
  }

  /// Decode the next picture and report its presentation time.
  #[napi]
  pub fn next_frame(&mut self) -> Result<FrameResult> {
    let started = std::time::Instant::now();
    let frame = self.inner.next_frame().map_err(Error::from_reason)?;
    let end_of_stream = frame.is_none();
    if let Some(frame) = frame {
      self.frames_decoded += 1;
      self.last_timestamp = frame.pts_ms;
    }
    Ok(FrameResult { end_of_stream, timestamp: self.last_timestamp,
      frames_decoded: self.frames_decoded as f64,
      decode_ms: started.elapsed().as_secs_f64() * 1000.0, texture: None })
  }

  /// Seek to a millisecond offset. Lands on the preceding keyframe.
  #[napi]
  pub fn seek(&mut self, ms: f64) -> Result<()> {
    self.inner.seek_to_keyframe_before(ms).map_err(Error::from_reason)
  }
}

#[napi(object)]
pub struct ProbeResult {
  pub opened: bool,
  pub error: String,
  pub native_types: Vec<String>,
}

#[napi(object)]
pub struct AudioProbe {
  pub has_audio: bool,
  pub sample_rate: u32,
  pub channels: u32,
  pub duration: f64,
}

#[napi]
pub fn probe_video(path: String) -> ProbeResult {
  let result = VideoSource::open(&path).and_then(|mut source| {
    source.next_frame()?.ok_or_else(|| format!("no decodable H.264 frame in {path}"))
  });
  match result {
    Ok(_) => ProbeResult { opened: true, error: String::new(), native_types: vec!["avc1".into()] },
    Err(error) => ProbeResult { opened: false, error, native_types: Vec::new() },
  }
}

/// Inspect the first Opus track without buffering media data.
#[napi]
pub fn probe_audio(path: String) -> AudioProbe {
  match audio::read_opus_header(&path) {
    Ok(Some(header)) => AudioProbe { has_audio: true, sample_rate: 48_000,
      channels: header.channels as u32, duration: header.duration_ms },
    _ => AudioProbe { has_audio: false, sample_rate: 0, channels: 0, duration: 0.0 },
  }
}

#[napi]
pub fn list_decoders() -> Vec<String> { vec!["openh264 (software)".into()] }
#[napi]
pub fn adapter_info() -> Vec<String> { Vec::new() }
#[napi]
pub fn gpu_decoder_profiles() -> Vec<String> { Vec::new() }

#[napi(object)]
pub struct GpuMemory { pub used: f64, pub budget: f64 }
#[napi]
pub fn gpu_memory() -> GpuMemory { GpuMemory { used: 0.0, budget: 0.0 } }

#[napi(object)]
pub struct SpritesheetOptions {
  pub max_frames: Option<u32>,
  pub cell_width: Option<u32>,
  pub max_columns: Option<u32>,
}

#[napi(object)]
pub struct SpritesheetInfo {
  pub frame_count: u32,
  pub interval_ms: f64,
  pub frame_width: u32,
  pub frame_height: u32,
  pub columns: u32,
  pub rows: u32,
  pub total_duration_ms: f64,
  pub image_path: String,
}

fn sheet_budget(options: Option<SpritesheetOptions>) -> SheetBudget {
  let defaults = SheetBudget::default();
  let Some(options) = options else { return defaults };
  SheetBudget {
    max_frames: options.max_frames.map(|value| value.max(1) as usize).unwrap_or(defaults.max_frames),
    cell_width: options.cell_width.map(|value| value.max(1)).unwrap_or(defaults.cell_width),
    max_columns: options.max_columns.map(|value| value.max(1)).unwrap_or(defaults.max_columns),
  }
}

pub struct BuildSpritesheet { input: String, output: String, budget: SheetBudget }
impl Task for BuildSpritesheet {
  type Output = (SheetPlan, f64);
  type JsValue = SpritesheetInfo;
  fn compute(&mut self) -> Result<Self::Output> {
    thumbnails::generate(&self.input, &self.output, self.budget).map_err(Error::from_reason)
  }
  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    let (plan, duration_ms) = output;
    Ok(SpritesheetInfo { frame_count: plan.frame_count as u32,
      interval_ms: plan.interval_ms, frame_width: plan.cell_width,
      frame_height: plan.cell_height, columns: plan.columns, rows: plan.rows,
      total_duration_ms: duration_ms, image_path: std::mem::take(&mut self.output) })
  }
}

/// Build the timeline filmstrip on a worker and return its PNG geometry.
#[napi(ts_return_type = "Promise<SpritesheetInfo>")]
pub fn generate_spritesheet(input: String, output: String,
  options: Option<SpritesheetOptions>) -> AsyncTask<BuildSpritesheet> {
  AsyncTask::new(BuildSpritesheet { input, output, budget: sheet_budget(options) })
}

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
  /// Drop shadows under the recording, drawn in the order given. Empty is none.
  pub shadows: Option<Vec<ShadowLayer>>,
}

impl From<VideoPlacement> for scene::VideoLayout {
  fn from(placement: VideoPlacement) -> Self {
    scene::VideoLayout {
      rect: Rect {
        x: placement.x as f32,
        y: placement.y as f32,
        width: placement.width as f32,
        height: placement.height as f32,
      },
      corner_radius: placement.corner_radius.unwrap_or(0.0) as f32,
      border_width: placement.border_width.unwrap_or(0.0) as f32,
      border_colour: colour_or(placement.border_colour.as_ref(), [0.0, 0.0, 0.0, 1.0]),
      shadows: placement
        .shadows
        .unwrap_or_default()
        .into_iter()
        .map(Shadow::from)
        .collect(),
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
  pub shadows: Option<Vec<ShadowLayer>>,
}

/// One drop shadow, under the recording or under the camera.
///
/// The same four numbers a CSS box-shadow carries, because the editor's styles
/// are authored as shadow stacks and this is where they arrive.
#[napi(object)]
pub struct ShadowLayer {
  /// Canvas pixels, positive right and down. Default 0.
  pub offset_x: Option<f64>,
  pub offset_y: Option<f64>,
  /// Canvas's `shadowBlur`: a Gaussian of sigma = blur/2. Default 0, which is a
  /// hard offset silhouette rather than nothing.
  pub blur: Option<f64>,
  /// A fully transparent shadow is dropped rather than drawn.
  pub colour: Option<Colour>,
}

impl From<ShadowLayer> for Shadow {
  fn from(shadow: ShadowLayer) -> Self {
    Shadow {
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
        .map(Shadow::from)
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

impl From<CursorEffectSpec> for scene::CursorEffects {
  fn from(spec: CursorEffectSpec) -> Self {
    scene::CursorEffects {
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

/// Settings for one independent export worker.
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
  /// "auto" (the default) uses the GPU's H.264 encoder when there is one and
  /// the software encoder otherwise; "hardware" fails without one; "software"
  /// never touches the GPU encoder.
  pub encoder: Option<String>,
}

#[napi(object)]
pub struct ExportProgress {
  pub frames_done: f64,
  pub frames_total: f64,
  pub finished: bool,
  pub cancelled: bool,
  pub error: Option<String>,
  pub fps: f64,
  pub steady_fps: f64,
  pub setup_ms: f64,
  pub avg_decode_ms: f64,
  pub avg_render_ms: f64,
  pub avg_encode_ms: f64,
  pub elapsed_ms: f64,
  /// The video encoder in use, such as "NVENC on NVIDIA GeForce RTX 4050
  /// Laptop GPU"; absent until it opens.
  pub encoder: Option<String>,
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

impl From<SourceCropSpec> for scene::SourceCrop {
  fn from(spec: SourceCropSpec) -> Self {
    scene::SourceCrop {
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


#[cfg(test)]
mod api_scenarios {
  use super::*;
  use crate::engine::linux::media::fixtures::{path, recording};
  #[test]
  fn decoder_reports_eos_after_ninety_frames() {
    let fixture = recording(false);
    let mut decoder = VideoDecoder::new(fixture.0.to_str().unwrap().into()).unwrap();
    for count in 1..=90 {
      let result = decoder.next_frame().unwrap();
      assert!(!result.end_of_stream);
      assert_eq!(result.frames_decoded, count as f64);
      assert!(result.texture.is_none());
    }
    assert!(decoder.next_frame().unwrap().end_of_stream);
  }
  #[test]
  fn video_probe_requires_a_decodable_h264_frame() {
    let fixture = recording(false);
    let probe = probe_video(fixture.0.to_str().unwrap().into());
    assert!(probe.opened);
    assert_eq!(probe.native_types, ["avc1"]);
    let text = path("invalid", "txt");
    std::fs::write(&text, b"plain text").unwrap();
    let probe = probe_video(text.to_str().unwrap().into());
    let _ = std::fs::remove_file(text);
    assert!(!probe.opened);
    assert!(!probe.error.is_empty());
  }
  #[test]
  fn audio_probe_reads_opus_channels_and_detects_silent_video() {
    let fixture = recording(true);
    let probe = probe_audio(fixture.0.to_str().unwrap().into());
    assert!(probe.has_audio);
    assert_eq!((probe.sample_rate, probe.channels), (48_000, 2));
    assert!(probe.duration > 0.0);
    let fixture = recording(false);
    assert!(!probe_audio(fixture.0.to_str().unwrap().into()).has_audio);
  }
  #[test]
  fn zero_sheet_options_are_clamped_before_planning() {
    let budget = sheet_budget(Some(SpritesheetOptions {
      max_frames: Some(0), cell_width: Some(0), max_columns: Some(0) }));
    assert_eq!((budget.max_frames, budget.cell_width, budget.max_columns), (1, 1, 1));
  }
}

fn build_background(background: BackgroundSpec) -> Result<scene::BackgroundRequest> {
  let clear = colour_or(background.colour.as_ref(), [0.0, 0.0, 0.0, 1.0]);
  let image = background.image.map(|image| {
    let expected = image.width as usize * image.height as usize * 4;
    if image.pixels.len() < expected {
      Err(Error::from_reason(format!("background image is {} bytes, expected {} for {}x{} RGBA",
        image.pixels.len(), expected, image.width, image.height)))
    } else {
      Ok(scene::RgbaImage { width: image.width, height: image.height, pixels: image.pixels.to_vec() })
    }
  }).transpose()?;
  Ok(scene::BackgroundRequest { clear, image })
}

/// A background export. Cancellation still finalises its MP4.
#[napi]
pub struct VideoExporter { inner: exporter::Exporter }

#[napi]
impl VideoExporter {
  #[napi(constructor)]
  pub fn new(input: String, options: ExportOptions) -> Result<Self> {
    let cursor_image = options.cursor.map(CursorBitmap::into_image).transpose()?;
    let cursor_images = options.cursor_images.unwrap_or_default().into_iter()
      .map(CursorBitmap::into_image).collect::<Result<Vec<_>>>()?;
    let encoder = match options.encoder.as_deref() {
      None | Some("auto") => EncoderChoice::Auto,
      Some("hardware") => EncoderChoice::Hardware,
      Some("software") => EncoderChoice::Software,
      Some(other) => return Err(Error::from_reason(format!(
        "unknown encoder {other:?}; expected \"auto\", \"hardware\" or \"software\""))),
    };
    Ok(Self { inner: exporter::Exporter::start(exporter::Options {
      input, output: options.output, bitrate: options.bitrate as u32, encoder,
      start_ms: options.start.unwrap_or(0.0), end_ms: options.end.unwrap_or(0.0),
      effects: scene::EffectParams {
        brightness: options.brightness.unwrap_or(0.0) as f32,
        contrast: options.contrast.unwrap_or(1.0) as f32,
        saturation: options.saturation.unwrap_or(1.0) as f32,
      },
      webcam_effects: scene::EffectParams {
        brightness: options.webcam_brightness.unwrap_or(0.0) as f32,
        contrast: options.webcam_contrast.unwrap_or(1.0) as f32,
        saturation: options.webcam_saturation.unwrap_or(1.0) as f32,
      },
      canvas: match (options.canvas_width, options.canvas_height) {
        (Some(w), Some(h)) => Some((w, h)), _ => None,
      },
      layout: options.layout.map(scene::VideoLayout::from),
      background: options.background.map(build_background).transpose()?,
      webcam_path: options.webcam_path,
      webcam_layout: options.webcam.map(WebcamLayout::from),
      cursor_image, cursor_images,
      cursor_track: options.cursor_track.unwrap_or_default().into_iter().map(CursorSample::from).collect(),
      zoom_regions: options.zoom_regions.unwrap_or_default().into_iter().map(zoom::ZoomRegion::from).collect(),
      audio_sources: options.audio_sources.unwrap_or_default().into_iter()
        .map(|source| (source.path, source.offset_ms.unwrap_or(0.0))).collect(),
      cuts: options.cuts.unwrap_or_default().into_iter().map(cuts::Cut::from).collect(),
      crop: options.crop.map(scene::SourceCrop::from),
      cursor_size: options.cursor_size.unwrap_or(22.0) as f32,
      cursor_opacity: options.cursor_opacity.unwrap_or(1.0).clamp(0.0, 1.0) as f32,
      cursor_effects: options.cursor_effects.map(scene::CursorEffects::from).unwrap_or_default(),
      webcam_cuts: options.webcam_cuts.unwrap_or_default().into_iter()
        .map(|region| (region.start_ms, region.end_ms)).collect(),
      layer_order: options.layer_order.as_deref().map(scene::parse_layer_order)
        .unwrap_or(scene::DEFAULT_LAYER_ORDER),
      webcam_zoom_regions: options.webcam_zoom_regions.unwrap_or_default().into_iter()
        .map(zoom::WebcamZoomRegion::from).collect(),
    }) })
  }
  #[napi]
  pub fn progress(&self) -> ExportProgress {
    let p = self.inner.progress();
    ExportProgress { frames_done: p.frames_done as f64, frames_total: p.frames_total as f64,
      finished: p.finished, cancelled: p.cancelled, error: p.error, fps: p.fps,
      steady_fps: p.steady_fps, setup_ms: p.setup_ms, avg_decode_ms: p.avg_decode_ms,
      avg_render_ms: p.avg_render_ms, avg_encode_ms: p.avg_encode_ms, elapsed_ms: p.elapsed_ms,
      encoder: p.encoder }
  }
  #[napi]
  pub fn cancel(&self) { self.inner.cancel(); }
}

/// Clocked preview backed by a fixed pool of DMA-BUF frames.
#[napi]
pub struct VideoPlayer { inner: player::Player }

#[napi]
impl VideoPlayer {
  #[napi(constructor)]
  pub fn new(path: String) -> Result<Self> {
    Ok(Self { inner: player::Player::open(&path).map_err(Error::from_reason)? })
  }
  #[napi(factory)]
  pub fn open(sources: PlayerSources) -> Result<Self> {
    let canvas = match (sources.canvas_width, sources.canvas_height) {
      (Some(width), Some(height)) => Some((width, height)), _ => None,
    };
    Ok(Self { inner: player::Player::open_with_webcam(&sources.path,
      sources.webcam_path.as_deref(), canvas).map_err(Error::from_reason)? })
  }
  #[napi]
  pub fn info(&self) -> VideoInfo {
    let (source, canvas) = self.inner.info();
    VideoInfo { width: canvas.0, height: canvas.1, coded_width: canvas.0,
      coded_height: canvas.1, duration: source.duration_ms, fps: source.fps }
  }
  #[napi]
  pub fn pool_textures(&self) -> Vec<SharedTextureInfo> { self.inner.pool_textures() }
  #[napi]
  pub fn play(&self) { self.inner.set_playing(true); }
  #[napi]
  pub fn pause(&self) { self.inner.set_playing(false); }
  #[napi]
  pub fn set_rate(&self, rate: f64) { self.inner.set_rate(rate); }
  #[napi]
  pub fn seek(&self, ms: f64, exact: Option<bool>) {
    self.inner.seek(ms, if exact.unwrap_or(true) { player::SeekMode::Exact } else { player::SeekMode::Fast });
  }
  #[napi]
  pub fn tick(&self) -> Option<PresentedFrame> {
    self.inner.tick().map(|frame| PresentedFrame {
      pts: frame.pts_ms, texture: self.inner.texture_info(frame),
    })
  }
  #[napi]
  pub fn set_webcam_layout(&self, layout: WebcamOverlay) { self.inner.set_webcam_layout(layout.into()); }
  #[napi]
  pub fn has_webcam(&self) -> bool { self.inner.has_webcam() }
  #[napi]
  pub fn snapshot_bgra(&self) -> Option<Buffer> { self.inner.snapshot_bgra().map(Buffer::from) }
  #[napi]
  pub fn cursor_sample_count(&self) -> f64 { self.inner.cursor_sample_count() as f64 }
  #[napi]
  pub fn cursor_image_count(&self) -> f64 { self.inner.cursor_image_count() as f64 }
  #[napi]
  pub fn set_cursor_images(&self, images: Vec<CursorBitmap>) -> Result<()> {
    self.inner.set_cursor_images(images.into_iter().map(CursorBitmap::into_image)
      .collect::<Result<Vec<_>>>()?);
    Ok(())
  }
  #[napi]
  pub fn set_cursor_image(&self, image: Option<CursorBitmap>) -> Result<()> {
    self.inner.set_cursor_image(image.map(CursorBitmap::into_image).transpose()?);
    Ok(())
  }
  #[napi]
  pub fn set_cursor_track(&self, samples: Vec<CursorPoint>) {
    self.inner.set_cursor_track(samples.into_iter().map(CursorSample::from).collect());
  }
  #[napi]
  pub fn set_webcam_zoom_regions(&self, regions: Vec<WebcamZoomRegionSpec>) {
    self.inner.set_webcam_zoom_regions(regions.into_iter().map(zoom::WebcamZoomRegion::from).collect());
  }
  #[napi]
  pub fn set_layer_order(&self, order: Vec<String>) {
    self.inner.set_layer_order(scene::parse_layer_order(&order));
  }
  #[napi]
  pub fn set_webcam_cuts(&self, spans: Vec<CutRegion>) {
    self.inner.set_webcam_cuts(spans.into_iter().map(|span| (span.start_ms, span.end_ms)).collect());
  }
  #[napi]
  pub fn set_cursor_style(&self, size: f64, opacity: f64) {
    self.inner.set_cursor_style(size as f32, opacity as f32);
  }
  #[napi]
  pub fn set_cursor_effects(&self, effects: CursorEffectSpec) {
    self.inner.set_cursor_effects(effects.into());
  }
  #[napi]
  pub fn set_zoom_regions(&self, regions: Vec<ZoomRegion>) {
    self.inner.set_zoom_regions(regions.into_iter().map(zoom::ZoomRegion::from).collect());
  }
  #[napi]
  pub fn zoom_region_count(&self) -> f64 { self.inner.zoom_region_count() as f64 }
  #[napi]
  pub fn set_cuts(&self, regions: Vec<CutRegion>) {
    self.inner.set_cuts(regions.into_iter().map(cuts::Cut::from).collect());
  }
  #[napi]
  pub fn set_source_crop(&self, crop: Option<SourceCropSpec>) {
    self.inner.set_source_crop(crop.map(scene::SourceCrop::from));
  }
  #[napi]
  pub fn cut_count(&self) -> f64 { self.inner.cut_count() as f64 }
  #[napi]
  pub fn composition_duration(&self) -> f64 { self.inner.composition_duration_ms() }
  #[napi]
  pub fn set_effects(&self, brightness: f64, contrast: f64, saturation: f64) {
    self.inner.set_effects(scene::EffectParams {
      brightness: brightness as f32, contrast: contrast as f32, saturation: saturation as f32 });
  }
  #[napi]
  pub fn set_webcam_effects(&self, brightness: f64, contrast: f64, saturation: f64) {
    self.inner.set_webcam_effects(scene::EffectParams {
      brightness: brightness as f32, contrast: contrast as f32, saturation: saturation as f32 });
  }
  #[napi]
  pub fn set_layout(&self, placement: VideoPlacement) { self.inner.set_layout(placement.into()); }
  #[napi]
  pub fn set_background(&self, background: BackgroundSpec) -> Result<()> {
    self.inner.set_background(build_background(background)?);
    Ok(())
  }
  #[napi]
  pub fn stats(&self) -> PlayerStats {
    let stats = self.inner.stats();
    PlayerStats { queue_depth: stats.queue_depth, decoded: stats.decoded as f64,
      dropped: stats.dropped as f64, skipped_no_texture: stats.skipped_no_texture as f64,
      skipped_render_error: stats.skipped_render_error as f64,
      max_queue_wait_us: stats.max_queue_wait_us as f64, avg_decode_ms: stats.avg_decode_ms,
      last_seek_ms: stats.last_seek_ms, last_seek_decoded: stats.last_seek_decoded,
      end_of_stream: stats.end_of_stream, playing: stats.playing,
      current_time: stats.current_time_ms, rate: stats.rate }
  }
  #[napi]
  pub fn close(&mut self) { self.inner.close(); }
}
