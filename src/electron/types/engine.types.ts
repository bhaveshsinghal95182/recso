/**
 * Hand-mirrored view of velocity's generated `index.d.ts`.
 *
 * The main process cannot import that file directly: it only exists after a
 * Rust build, so `tsc -p src/electron` would fail on a clean checkout. This is
 * the contract instead, and it has to be updated by hand whenever the napi
 * surface in `velocity/src/engine/api.rs` changes.
 *
 * Only the engine exports are mirrored here. Recording, cursor and window
 * bindings have their own types next to the services that use them.
 */

/**
 * Everything Electron's `importSharedTexture` needs, in the shape it wants.
 *
 * `handle` is a raw NT HANDLE and is only meaningful in the process that
 * created it -- the main process, because that is where the addon is loaded.
 */
export interface SharedTextureInfo {
  /**
   * Raw NT HANDLE as a number, not a Buffer. The preview path runs at display
   * rate, and allocating an external buffer per frame put V8 GC pauses on the
   * UI thread. There are only as many distinct handles as the pool has slots,
   * so the main process caches one Buffer per value instead.
   */
  handle: number;
  /** Full allocated size of the texture. */
  width: number;
  height: number;
  /**
   * The meaningful sub-rectangle. Decoders pad to macroblock alignment, so
   * this is often smaller than the coded size.
   */
  visibleWidth: number;
  visibleHeight: number;
  /** One of `bgra` | `rgba` | `rgbaf16` | `nv12`. */
  pixelFormat: string;
  /** Microseconds, surfaced on the resulting `VideoFrame`. */
  timestamp: number;
}

export interface VideoInfo {
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  /** Milliseconds. */
  duration: number;
  /** Frames per second as the container reports it (24000/1001 -> 23.976). */
  fps: number;
}

export interface FrameResult {
  endOfStream: boolean;
  /** Milliseconds into the file. */
  timestamp: number;
  framesDecoded: number;
  /** Wall-clock cost of decode + GPU copy for this frame, in ms. */
  decodeMs: number;
  texture?: SharedTextureInfo;
}

export interface PresentedFrame {
  texture: SharedTextureInfo;
  /** Presentation timestamp of this frame, in milliseconds. */
  pts: number;
}

export interface PlayerStats {
  /** Frames decoded ahead and waiting to be presented. */
  queueDepth: number;
  decoded: number;
  /** Frames that came due late and were skipped to keep time. */
  dropped: number;
  /**
   * Samples the decoder produced with no texture, and frames the render layer
   * refused. Both should stay at zero; anything else is a silent frame loss.
   */
  skippedNoTexture: number;
  skippedRenderError: number;
  /** Worst microseconds `tick` spent waiting on the frame queue lock. */
  maxQueueWaitUs: number;
  avgDecodeMs: number;
  lastSeekMs: number;
  /** Frames the last seek decoded forward -- the GOP cost of exactness. */
  lastSeekDecoded: number;
  endOfStream: boolean;
  playing: boolean;
  /** Playhead in milliseconds, from the engine clock. */
  currentTime: number;
  rate: number;
}

/**
 * What to export, and everything the preview is drawing on top of it.
 *
 * The overlay fields are not optional extras: the exporter builds its own
 * render chain on its own thread, so it starts with no webcam and no cursor and
 * has nothing to inherit them from. Leave them out and the file is missing two
 * layers the preview was showing.
 */
export interface ExportOptions {
  output: string;
  /** Target bitrate in bits per second. */
  bitrate: number;
  /** Milliseconds. Defaults to the whole file. */
  start?: number;
  end?: number;
  /** The video layer's grade. Pass whatever the preview is currently showing. */
  brightness?: number;
  contrast?: number;
  saturation?: number;
  /** The webcam layer's own grade. */
  webcamBrightness?: number;
  webcamContrast?: number;
  webcamSaturation?: number;
  /** The canvas to compose onto. Defaults to the recording's visible size. */
  canvasWidth?: number;
  canvasHeight?: number;
  /** Where the recording sits on that canvas. Defaults to filling it. */
  layout?: VideoPlacement;
  /** What is behind the video. Only visible if `layout` insets it. */
  background?: BackgroundSpec;
  /** The zoom/pan timeline. Omit it and the export is unzoomed. */
  zoomRegions?: ZoomRegion[];
  /** Spans of the source to leave out. Omit and the whole range is exported. */
  cuts?: CutRegion[];
  /** Edges of the recording to throw away. Omit to keep all of it. */
  crop?: SourceCropSpec;
  /** The camera sidecar. Without it the export has no webcam overlay. */
  webcamPath?: string;
  /** Where the camera goes -- the same value passed to `setWebcamLayout`. */
  webcam?: WebcamOverlay;
  /** The pointer bitmap, as passed to `setCursorImage`. Drawn for samples
   *  that do not name one of `cursorImages`. */
  cursor?: CursorBitmap;
  /** The per-sample pointer bitmaps, as passed to `setCursorImages`. */
  cursorImages?: CursorBitmap[];
  /** The recorded pointer path, as passed to `setCursorTrack`. */
  cursorTrack?: CursorPoint[];
  /** Cursor height in destination pixels. Defaults to 22, as the editor does. */
  cursorSize?: number;
  /** Clamped to 0..1. Defaults to 1. */
  cursorOpacity?: number;
  /** The click pop and the smear. Omit and the pointer draws plainly. */
  cursorEffects?: CursorEffectSpec;
  /** Spans of the composition to leave the camera out of. */
  webcamCuts?: CutRegion[];
  /** Which layer sits on top of which, bottom first. */
  layerOrder?: string[];
  /** Spans where the camera changes size, or expands to the whole frame. */
  webcamZoomRegions?: WebcamZoomRegionSpec[];
  /**
   * Every file contributing sound. Omit it and the export is silent.
   *
   * Not inferred from the input and the camera sidecar: which tracks belong in
   * the mix is an editing decision, and muting the camera should be a matter of
   * leaving it out of this list.
   */
  audioSources?: EngineAudioSource[];
}

/**
 * One span where the camera changes size, or takes the whole frame.
 *
 * `rect` is the box the camera sits in while the region is held, already laid
 * out by the caller -- the engine eases between rectangles rather than
 * recomputing one, so the placement formula stays in one place.
 */
export interface WebcamZoomRegionSpec {
  startMs: number;
  endMs: number;
  /** Milliseconds of smoothstep at each end. 0 snaps. */
  easeDurationMs: number;
  rect: VideoPlacement;
  /** Expand to the whole canvas, dissolving radius and border on the way. */
  fullScreen?: boolean;
}

/** One file contributing sound to an export. */
export interface EngineAudioSource {
  path: string;
  /**
   * Milliseconds to shift this file by so it sits on the screen recording's
   * clock. A camera sidecar that started late has a positive offset.
   */
  offsetMs?: number;
}

export interface ExportProgress {
  framesDone: number;
  /** Estimated from the range and frame rate, so treat it as approximate. */
  framesTotal: number;
  finished: boolean;
  cancelled: boolean;
  error?: string;
  fps: number;
  /** Frames per second once encoding is running, excluding setup. */
  steadyFps: number;
  /** Time before the first frame: decoder open, shader compile, encoder init. */
  setupMs: number;
  avgDecodeMs: number;
  avgRenderMs: number;
  avgEncodeMs: number;
  elapsedMs: number;
}

export interface PipelineStep {
  endOfStream: boolean;
  /** Milliseconds into the source. */
  timestamp: number;
  framesDecoded: number;
  framesEncoded: number;
  decodeMs: number;
  encodeMs: number;
  /** Present when preview was requested and a frame was produced. */
  texture?: SharedTextureInfo;
}

export interface ProbeResult {
  opened: boolean;
  error: string;
  nativeTypes: string[];
}

export interface GpuMemory {
  /** Bytes of local (on-GPU) memory this process is using. */
  used: number;
  /** What the OS is willing to give us right now. */
  budget: number;
}

export interface VideoPlayerInstance {
  info(): VideoInfo;
  /**
   * Every texture in the pool, so the app can force the GPU process to import
   * them all up front.
   */
  poolTextures(): SharedTextureInfo[];
  play(): void;
  pause(): void;
  setRate(rate: number): void;
  /**
   * `exact` decodes forward to the frame covering `ms`, which costs a GOP.
   * Pass `false` while dragging a scrubber and `true` when it is released.
   */
  seek(ms: number, exact?: boolean | null): void;
  /**
   * Ask for the frame that should be on screen now. Returns null when the
   * current frame is still the right one, which is the normal case whenever
   * the display refreshes faster than the video.
   */
  tick(): PresentedFrame | null;
  /** Applies to preview immediately, and the exporter runs the same chain. */
  setEffects(brightness: number, contrast: number, saturation: number): void;

  /**
   * Place the webcam overlay, in the screen recording's own pixels.
   *
   * The anchor grid and size ratios are resolved caller-side and passed here
   * already flattened, so there is one placement formula in the app rather than
   * two that have to agree.
   */
  setWebcamLayout(layout: WebcamOverlay): void;
  /** Place the recording on the canvas: rect, corner radius, border. */
  setLayout(placement: VideoPlacement): void;
  /** Set the zoom/pan timeline. */
  setZoomRegions(regions: ZoomRegion[]): void;
  /** Remove spans of the recording. Regions are in source time. */
  setCuts(regions: CutRegion[]): void;
  /** Throw away the edges of the recording. `null` keeps all of it. */
  setSourceCrop(crop: SourceCropSpec | null): void;
  /** Cuts loaded. Applied asynchronously. */
  cutCount(): number;
  /** The edit's length: the file's duration less what has been cut. */
  compositionDuration(): number;
  /** Zoom regions loaded. Applied asynchronously. */
  zoomRegionCount(): number;
  /** What fills the canvas behind the video. */
  setBackground(background: BackgroundSpec): void;
  /** Grade the webcam layer, separately from the video. */
  setWebcamEffects(brightness: number, contrast: number, saturation: number): void;
  /** False when the recording had no camera track, or its sidecar would not open. */
  hasWebcam(): boolean;

  setCursorImage(image?: CursorBitmap | null): void;
  /** The per-sample bitmap table. Replaces it wholesale. */
  setCursorImages(images: CursorBitmap[]): void;
  setCursorTrack(samples: CursorPoint[]): void;
  /** Cursor height in destination pixels, and its opacity. Size 0 hides it. */
  setCursorStyle(size: number, opacity: number): void;
  /** The click pop and the smear, both resolved per frame against the track. */
  setCursorEffects(effects: CursorEffectSpec): void;
  /** Spans of the composition to leave the camera out of. Composition time. */
  setWebcamCuts(spans: CutRegion[]): void;
  /** Which layer sits on top of which, bottom first. Empty means the default. */
  setLayerOrder(order: string[]): void;
  /** Spans where the camera changes size, or expands to the whole frame. */
  setWebcamZoomRegions(regions: WebcamZoomRegionSpec[]): void;
  /** Pointer samples the decode thread has loaded. Applied asynchronously. */
  cursorSampleCount(): number;
  /** Pointer bitmaps resident. Applied asynchronously, like the sample count. */
  cursorImageCount(): number;

  /**
   * The composited frame currently on screen, as BGRA bytes.
   *
   * Includes grading, the webcam box and the cursor. Stalls the GPU -- for
   * stills and verification, not playback.
   */
  snapshotBgra(): Buffer | null;
  stats(): PlayerStats;
  /** Stop the decode thread and release the texture pool. */
  close(): void;
}

export interface VideoExporterInstance {
  progress(): ExportProgress;
  cancel(): void;
}

export interface VideoDecoderInstance {
  info(): VideoInfo;
  nextFrame(): FrameResult;
  seek(ms: number): void;
}

export interface PipelineInstance {
  info(): VideoInfo;
  startExport(output: string, fps: number, bitrate: number): void;
  step(preview: boolean, encode: boolean): PipelineStep;
  seek(ms: number): void;
  finishExport(): number;
}

export interface TestPatternSourceInstance {
  render(): SharedTextureInfo;
  textureInfo(): SharedTextureInfo;
}

export interface PatternEncoderInstance {
  writeFrame(): number;
  framesWritten(): number;
  finish(): void;
}

export interface EngineBindings {
  VideoPlayer: (new (path: string) => VideoPlayerInstance) & {
    /** Open a recording that has more than one video file. */
    open(sources: PlayerSources): VideoPlayerInstance;
  };
  VideoExporter: new (input: string, options: ExportOptions) => VideoExporterInstance;
  VideoDecoder: new (path: string) => VideoDecoderInstance;
  Pipeline: new (input: string) => PipelineInstance;
  TestPatternSource: new (width: number, height: number) => TestPatternSourceInstance;
  PatternEncoder: new (
    path: string,
    width: number,
    height: number,
    fps: number,
    bitrate: number,
  ) => PatternEncoderInstance;

  engineVersion(): string;
  /** Which GPUs exist, and which one are we actually running on? */
  adapterInfo(): string[];
  /** Which decoder MFTs exist for H.264 and HEVC on this machine? */
  listDecoders(): string[];
  /** What can the GPU itself decode, independent of Media Foundation? */
  gpuDecoderProfiles(): string[];
  /** What does Media Foundation see in this file? */
  probeVideo(path: string): ProbeResult;
  /** GPU-side memory usage, so a scrub test can show whether textures leak. */
  gpuMemory(): GpuMemory;
}

/**
 * What the engine opened, reconciled against what the recorder reported.
 *
 * The two can disagree. Where they do, the recorder wins on duration and fps:
 * it counted frames as they were captured, while the container carries a
 * nominal rate that screen capture never actually hits. Geometry should always
 * agree, so a mismatch there is worth surfacing rather than papering over.
 */
export interface OpenedVideo {
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  /**
   * Milliseconds, from the container -- what the decoder will actually produce
   * and what seeking is bounded by.
   */
  duration: number;
  /**
   * Wall-clock length of the capture session, when the recorder reported it.
   *
   * Differs from `duration` by up to a frame: the recorder times first frame to
   * stop, the container runs sample zero to the end of the last sample.
   */
  captureDuration?: number;
  /**
   * Measured average from the recorder when available, otherwise the
   * container's nominal rate.
   */
  fps: number;
  /** Where `fps` and the extra fields came from. */
  source: 'recorder' | 'container';
  /** Frames the recorder counted. Absent when opening a file it did not write. */
  frames?: number;
  /** Whether the file carries real audio. Absent without recorder metadata. */
  hasAudio?: boolean;
  codec?: string;
  /** Exactly what Media Foundation reported, for comparison. */
  container: VideoInfo;
  /** Human-readable notes wherever the recorder and the container disagreed. */
  disagreements: string[];
}

/** Where the webcam overlay sits, in the screen recording's own pixels. */
/**
 * A colour as four 0..1 channels.
 *
 * Not a CSS string: the shader wants floats, and the one place that parses
 * `#rrggbb` should be the UI that already has the colour picker.
 */
export interface Colour {
  r: number;
  g: number;
  b: number;
  /** Defaults to 1. */
  a?: number;
}

/**
 * Where the recording sits on the canvas.
 *
 * Canvas pixels, resolved by the caller -- the padding fraction, the scale and
 * the centring stay on the renderer side next to the webcam's anchor grid, so
 * there is one layout formula in the app rather than two that have to agree.
 */
export interface VideoPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Corner radius in canvas pixels. Defaults to 0. */
  cornerRadius?: number;
  /** Border thickness, drawn outside the rect. Defaults to 0. */
  borderWidth?: number;
  borderColour?: Colour;
}

/**
 * What fills the canvas behind the video.
 *
 * Gradients and patterns arrive as `image`, already rasterised -- the editor's
 * backgrounds are static for a whole export, so drawing one to a canvas and
 * uploading the pixels beats reimplementing four generators in HLSL that would
 * then have to match the Canvas2D versions exactly.
 */
export interface BackgroundSpec {
  /** Flat fill, and what shows through a transparent image. Defaults to black. */
  colour?: Colour;
  /** Tightly packed RGBA8, stretched over the canvas. */
  image?: CursorBitmap;
}

/**
 * How much of each edge of the recording to throw away.
 *
 * Fractions of the visible frame rather than pixels, so a crop survives the
 * recording being scaled. Cropping does not resize anything -- the kept region
 * is stretched across whatever rect `setLayout` was given, so a crop that
 * changes the aspect ratio wants a matching rect.
 */
export interface SourceCropSpec {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * A span of the recording to leave out.
 *
 * In *source* time -- where it sits in the file. Everything the player reports
 * afterwards, its duration and playhead included, is in composition time: where
 * things sit in the resulting edit.
 */
export interface CutRegion {
  startMs: number;
  endMs: number;
}

/** A focal point a zoom pans to while it is held. */
export interface ZoomFocalKeyframe {
  timestampMs: number;
  /** 0..1 across the recording, not the canvas. */
  x: number;
  y: number;
}

/** One span of the timeline that is zoomed in. */
export interface ZoomRegion {
  startMs: number;
  endMs: number;
  /** 1 is no zoom. */
  zoomLevel: number;
  /**
   * Where it zooms to, 0..1 across the recording. Mapped through the video's
   * placement, so a zoom stays on its subject when the video is inset.
   */
  focalX: number;
  focalY: number;
  /** How long the ease in and the ease out each take. 0 snaps. */
  easeDurationMs?: number;
  /** Extra focal points to pan between while the zoom is held. */
  focalKeyframes?: ZoomFocalKeyframe[];
}

export interface WebcamOverlay {
  x: number;
  y: number;
  /** Zero width or height hides the overlay and costs nothing to render. */
  width: number;
  height: number;
  /** `rect` (default) or `ellipse`. */
  shape?: 'rect' | 'ellipse';
  /** Corner radius in pixels. Ignored for an ellipse. */
  cornerRadius?: number;
  /** Clamped to 0..1. Defaults to 1. */
  opacity?: number;
  /**
   * How a camera whose aspect ratio does not match the box is reconciled.
   *
   * `cover` (default) fills the box and crops the overflow, `contain` fits the
   * whole camera inside the box, `stretch` distorts it to fill exactly. Only
   * pass `stretch` when the box was computed from the camera's own aspect
   * ratio -- the engine will not notice when it was not.
   */
  fit?: 'cover' | 'contain' | 'stretch';
  /** Border thickness in canvas pixels, drawn outside the box. Defaults to 0. */
  borderWidth?: number;
  borderColour?: Colour;
}

/** A cursor bitmap: tightly packed RGBA8, plus where its point actually is. */
export interface CursorBitmap {
  width: number;
  height: number;
  pixels: Buffer;
  /**
   * The pointer's tip within the image, in image pixels. Without it an arrow
   * lands below and right of the place that was clicked.
   */
  hotspotX?: number;
  hotspotY?: number;
}

/** One recorded pointer position, normalised against the source video. */
export interface CursorPoint {
  timestampMs: number;
  /** 0..1 across the source frame. */
  x: number;
  y: number;
  /** Defaults to true. A hidden sample hides the cursor until the next one. */
  visible?: boolean;
  /**
   * Which bitmap this sample wore, as an index into `setCursorImages`.
   *
   * Omitted, or past the end of the table, draws the default pointer.
   */
  imageId?: number;
  /**
   * Whether the user clicked here. Defaults to false.
   *
   * On the sample rather than in its own list so a cut that drops the moment
   * drops the click with it.
   */
  click?: boolean;
}

/** What a click does to the pointer, and how far it stretches when it moves. */
export interface CursorEffectSpec {
  /** Peak scale of the click pop, about the hotspot. 1 or omitted disables it. */
  clickScale?: number;
  /** How long that pop lasts. 0 or omitted also disables it. */
  clickDurationMs?: number;
  /**
   * How far the pointer stretches along its travel, as a multiplier on the
   * distance it covered. 0 or omitted disables the smear. Capped engine-side.
   */
  smearStrength?: number;
}

/** What to open, when a recording is more than one file. */
export interface PlayerSources {
  path: string;
  /** The camera sidecar, if the recording has one. */
  webcamPath?: string;
  /**
   * The canvas to compose onto. Defaults to the recording's own visible size.
   *
   * Fixed for the life of the player: these are the dimensions of the textures
   * handed to Chromium, and changing them means re-importing every handle.
   * Inset the video with `setLayout` instead -- that moves freely.
   */
  canvasWidth?: number;
  canvasHeight?: number;
}
