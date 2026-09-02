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

export interface ExportOptions {
  output: string;
  /** Target bitrate in bits per second. */
  bitrate: number;
  /** Milliseconds. Defaults to the whole file. */
  start?: number;
  end?: number;
  /** Render settings. Pass whatever the preview is currently showing. */
  brightness?: number;
  contrast?: number;
  saturation?: number;
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
  /** False when the recording had no camera track, or its sidecar would not open. */
  hasWebcam(): boolean;

  setCursorImage(image?: CursorBitmap | null): void;
  setCursorTrack(samples: CursorPoint[]): void;
  /** Cursor height in destination pixels, and its opacity. Size 0 hides it. */
  setCursorStyle(size: number, opacity: number): void;
  /** Pointer samples the decode thread has loaded. Applied asynchronously. */
  cursorSampleCount(): number;

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
  /** Defaults to 1. */
  opacity?: number;
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
}

/** What to open, when a recording is more than one file. */
export interface PlayerSources {
  path: string;
  /** The camera sidecar, if the recording has one. */
  webcamPath?: string;
}
