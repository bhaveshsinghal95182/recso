import type { BackgroundPatternConfig } from '../shared/patterns';
import type {
  CropConfig,
  CursorConfig,
  CursorRegionOverride,
  CutRegion,
  DesktopSource,
  ExportConfig,
  FrameState,
  OrphanedRecording,
  Project,
  RecordedMouseEvent,
  RecordingConfig,
  SpritesheetMeta,
  StartRecordingResult,
  StopRecordingResult,
  TimelineLayer,
  TimelineLayerId,
  TimelineVisibilityMode,
  TransformedCursorPosition,
  WebcamOverlayConfig,
  ZoomConfig,
  ZoomRegion,
  ZoomSource,
} from './types';

// State event specific to IPC (contains uppercase State status)
export interface RecordingStateEvent {
  state: 'IDLE' | 'RECORDING' | 'PAUSED';
  recordingId: string | null;
  duration: number;
  bytesWritten: number;
}

export interface RecentProject {
  id: string;
  name: string;
  path: string;
  recordingId: string;
  thumbnail: string | null;
  openedAt: number;
  createdAt: number;
}

/** Everything the GPU video engine surfaces to the renderer. */
export interface EngineStatus {
  available: boolean;
  /** Why it is unavailable. Null when it loaded. */
  error: string | null;
  version: string | null;
  gpu: { engine: string; chromium: string; matched: boolean } | null;
}

export interface EngineVideoInfo {
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  /** Milliseconds. */
  duration: number;
  fps: number;
}

export interface EnginePlayerStats {
  queueDepth: number;
  decoded: number;
  dropped: number;
  skippedNoTexture: number;
  skippedRenderError: number;
  maxQueueWaitUs: number;
  avgDecodeMs: number;
  lastSeekMs: number;
  lastSeekDecoded: number;
  endOfStream: boolean;
  playing: boolean;
  currentTime: number;
  rate: number;
}

/** What a tick reports back, whether or not it produced a frame. */
export interface EngineTickResult {
  presented: boolean;
  pts?: number;
  sendMs?: number;
  currentTime: number;
  playing: boolean;
  rate: number;
  queueDepth: number;
  decoded: number;
  dropped: number;
  avgDecodeMs: number;
  lastSeekMs: number;
  lastSeekDecoded: number;
  endOfStream: boolean;
}

/**
 * Everything an engine export needs, which is everything the preview is showing.
 *
 * The overlay fields are not optional extras. An export that leaves them out is
 * not the video the user approved, because the preview drew them -- so this
 * mirrors the player's setters field for field, and `config-to-engine.ts`
 * resolves both from the same place.
 */
export interface EngineExportOptions {
  /** Where to write. The engine writes the file itself; nothing comes back
   *  through the renderer, which is what makes a multi-gigabyte source possible. */
  output: string;
  /** Target bitrate in bits per second. */
  bitrate: number;
  /** Milliseconds. Defaults to the whole file. */
  start?: number;
  end?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  webcamBrightness?: number;
  webcamContrast?: number;
  webcamSaturation?: number;
  /** The canvas to compose onto. Defaults to the recording's visible size. */
  canvasWidth?: number;
  canvasHeight?: number;
  /** Where the recording sits on that canvas. Defaults to filling it. */
  layout?: EngineVideoPlacement;
  background?: EngineBackground;
  zoomRegions?: EngineZoomRegion[];
  cuts?: EngineCutRegion[];
  crop?: EngineSourceCrop;
  /** The camera sidecar. Without it the export has no webcam overlay. */
  webcamPath?: string;
  webcam?: EngineWebcamOverlay;
  cursor?: EngineCursorBitmap;
  cursorImages?: EngineCursorBitmap[];
  cursorTrack?: EngineCursorPoint[];
  cursorSize?: number;
  cursorOpacity?: number;
  cursorEffects?: EngineCursorEffects;
  /** Spans of the composition to leave the camera out of. */
  webcamCuts?: EngineCutRegion[];
  /** Which layer sits on top of which, bottom first. */
  layerOrder?: string[];
  /** Spans where the camera changes size, or expands to the whole frame. */
  webcamZoomRegions?: EngineWebcamZoomRegion[];
  /** Every file contributing sound. Omit it and the export is silent. */
  audioSources?: EngineAudioSource[];
}

/** One file contributing sound to an export. */
export interface EngineAudioSource {
  path: string;
  /** Milliseconds to shift this file by so it sits on the recording's clock. */
  offsetMs?: number;
}

export interface EngineExportProgress {
  framesDone: number;
  framesTotal: number;
  finished: boolean;
  cancelled: boolean;
  error?: string;
  fps: number;
  steadyFps: number;
  setupMs: number;
  avgDecodeMs: number;
  avgRenderMs: number;
  avgEncodeMs: number;
  elapsedMs: number;
  output: string | null;
}

export interface EngineFrameInfo {
  frame: {
    format: string;
    codedWidth: number;
    codedHeight: number;
    displayWidth: number;
    displayHeight: number;
    timestamp: number;
  } | null;
  painted: number;
}

export interface EngineSinkInspection {
  pixels?: number;
  nonBlackPct?: number;
  distinctColours?: number;
  centrePixel?: number[];
  error?: string;
}

/** What the engine opened, reconciled against what the recorder reported. */
export interface EngineOpenedVideo {
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  /** Milliseconds, from the container: what the decoder produces and seeking is bounded by. */
  duration: number;
  /** Wall-clock length of the capture session, when the recorder reported it. */
  captureDuration?: number;
  /**
   * From the recorder when available, where it is a measured average rather
   * than the container's nominal rate. Screen capture is variable-rate, so for
   * anything frame-exact use `frames` and `duration` instead.
   */
  fps: number;
  source: 'recorder' | 'container';
  frames?: number;
  hasAudio?: boolean;
  codec?: string;
  container: EngineVideoInfo;
  /** Notes wherever the recorder and the container disagreed. */
  disagreements: string[];
}

/**
 * A colour as four 0..1 channels.
 *
 * Not a CSS string: the shader wants floats, and the one place that should be
 * parsing `#rrggbb` is the UI that already owns the colour picker.
 */
export interface EngineColour {
  r: number;
  g: number;
  b: number;
  /** Defaults to 1. */
  a?: number;
}

/**
 * How much of each edge of the recording to throw away.
 *
 * Fractions of the visible frame rather than pixels, so a crop survives the
 * recording being scaled. The kept region is stretched across whatever rect
 * `setLayout` was given, so a crop that changes the aspect ratio wants a
 * matching rect.
 */
export interface EngineSourceCrop {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * A span of the recording to leave out.
 *
 * In source time -- where it sits in the file. Everything the player reports
 * afterwards is in composition time: where things sit in the resulting edit.
 */
export interface EngineCutRegion {
  startMs: number;
  endMs: number;
}

/** A focal point a zoom pans to while it is held. */
export interface EngineZoomFocalKeyframe {
  timestampMs: number;
  /** 0..1 across the recording, not the canvas. */
  x: number;
  y: number;
}

/** One span of the timeline that is zoomed in. */
export interface EngineZoomRegion {
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
  focalKeyframes?: EngineZoomFocalKeyframe[];
}

/** Where the webcam overlay sits, in the screen recording's own pixels. */
export interface EngineWebcamOverlay {
  x: number;
  y: number;
  /** Zero width or height hides the overlay and costs nothing to render. */
  width: number;
  height: number;
  shape?: 'rect' | 'ellipse';
  /** Corner radius in pixels. Ignored for an ellipse. */
  cornerRadius?: number;
  /** Clamped to 0..1. Defaults to 1. */
  opacity?: number;
  /**
   * How a camera whose aspect ratio does not match the box is reconciled.
   *
   * `cover` (default) fills the box and crops the overflow, `contain` fits the
   * whole camera inside it, `stretch` distorts to fill exactly. Only pass
   * `stretch` when the box was computed from the camera's own aspect ratio.
   */
  fit?: 'cover' | 'contain' | 'stretch';
  /** Border thickness in canvas pixels, drawn outside the box. Defaults to 0. */
  borderWidth?: number;
  borderColour?: EngineColour;
  /** Drop shadows under the camera, drawn in the order given. Empty is none. */
  shadows?: EngineWebcamShadow[];
}

/**
 * One drop shadow under the camera.
 *
 * The same four numbers a CSS box-shadow carries, because the editor's webcam
 * styles are authored as shadow stacks and this is where they arrive.
 */
export interface EngineWebcamShadow {
  /** Canvas pixels, positive right and down. Default 0. */
  offsetX?: number;
  offsetY?: number;
  /**
   * Canvas's `shadowBlur`: a Gaussian of sigma = blur/2. Default 0, which is a
   * hard offset silhouette rather than nothing.
   */
  blur?: number;
  /** A fully transparent shadow is dropped rather than drawn. */
  colour?: EngineColour;
}

/**
 * Where the recording sits on the canvas.
 *
 * Canvas pixels: the padding fraction, the scale and the centring are resolved
 * here, next to the webcam's anchor grid, so there is one layout formula in the
 * app rather than two that have to agree.
 */
export interface EngineVideoPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Corner radius in canvas pixels. Defaults to 0. */
  cornerRadius?: number;
  /** Border thickness, drawn outside the rect. Defaults to 0. */
  borderWidth?: number;
  borderColour?: EngineColour;
}

/**
 * What fills the canvas behind the video.
 *
 * Gradients and patterns go in as `image`, already rasterised -- they are
 * static for a whole export, so drawing one to a canvas once and uploading the
 * pixels beats reimplementing the generators in HLSL where they would then have
 * to match the Canvas2D versions exactly.
 */
export interface EngineBackground {
  /** Flat fill, and what shows through a transparent image. Defaults to black. */
  colour?: EngineColour;
  /** Tightly packed RGBA8, stretched over the canvas. */
  image?: EngineCursorBitmap;
}

export interface EngineCursorBitmap {
  width: number;
  height: number;
  /** Tightly packed RGBA8. */
  pixels: ArrayBuffer;
  /**
   * The pointer's tip within the image. Without it an arrow lands below and
   * right of the place that was clicked.
   */
  hotspotX?: number;
  hotspotY?: number;
}

/** What a click does to the pointer, and how far it stretches when it moves. */
export interface EngineCursorEffects {
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

/** Where a paired phone should point its browser. */
export interface PhoneCameraSession {
  /** The address to show as a QR code: the best guess at a reachable one. */
  url: string;
  /** Every address this machine answers on, best first, for when the guess is wrong. */
  urls: string[];
  port: number;
}

export interface PhoneCameraState extends PhoneCameraSession {
  /** Whether a frame arrived recently enough that the phone is still showing the room. */
  live: boolean;
  framesReceived: number;
  /** Frames replaced before the recorder read them. Climbing alongside a low
   * frame count means the link cannot keep up. */
  framesDropped: number;
  width: number;
  height: number;
  /** What the phone last reported going wrong: permission refused, backgrounded. */
  lastError?: string;
}

/**
 * One span where the camera changes size, or takes the whole frame.
 *
 * `rect` is the box the camera sits in while the region is held, already laid
 * out by the caller -- the engine eases between rectangles rather than
 * recomputing one, so the placement formula stays in the editor.
 */
export interface EngineWebcamZoomRegion {
  startMs: number;
  endMs: number;
  /** Milliseconds of smoothstep at each end. 0 snaps. */
  easeDurationMs: number;
  rect: EngineVideoPlacement;
  /** Expand to the whole canvas, dissolving radius and border on the way. */
  fullScreen?: boolean;
}

export interface EngineCursorPoint {
  timestampMs: number;
  /** 0..1 across the source frame, so it survives the video being scaled. */
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
  /** Whether the user clicked here. Defaults to false. */
  click?: boolean;
}

export interface EngineAPI {
  /** Safe to call unconditionally; never throws. */
  status: () => Promise<EngineStatus>;
  diagnostics: () => Promise<{
    adapters: string[];
    decoders: string[];
    gpuProfiles: string[];
    memory: { used: number; budget: number };
  }>;
  /** What Media Foundation sees in a file, before committing to opening it. */
  probe: (path: string) => Promise<{ opened: boolean; error: string; nativeTypes: string[] }>;
  gpuMemory: () => Promise<{ used: number; budget: number }>;

  /**
   * Bind the canvas frames get painted into. Takes a selector because DOM
   * nodes cannot cross the contextBridge.
   */
  bindFrameSink: (selector: string) => boolean;
  unbindFrameSink: () => void;
  frameInfo: () => EngineFrameInfo;
  /** Reads the sink back, so an all-black canvas is distinguishable from success. */
  inspectFrameSink: () => EngineSinkInspection;

  player: {
    /**
     * `extras` carries the camera sidecar and the canvas to compose onto. The
     * canvas is fixed for the player's life -- inset the video with `setLayout`
     * rather than reopening.
     */
    open: (
      path: string,
      extras?: { webcamPath?: string; canvasWidth?: number; canvasHeight?: number },
    ) => Promise<EngineOpenedVideo>;
    /** Open a recording by id, using the metadata stored with it. No probe. */
    openRecording: (recordingId: string) => Promise<EngineOpenedVideo>;
    close: () => Promise<void>;
    warm: () => Promise<{ warmMs: number }>;
    play: () => Promise<void>;
    pause: () => Promise<void>;
    setRate: (rate: number) => Promise<void>;
    /** `exact: false` while dragging a scrubber, `true` on release. */
    seek: (ms: number, exact?: boolean) => Promise<void>;
    tick: () => Promise<EngineTickResult>;
    /** Grade the video layer. The webcam has its own. */
    setEffects: (brightness: number, contrast: number, saturation: number) => Promise<void>;
    /** Grade the webcam layer. */
    setWebcamEffects: (brightness: number, contrast: number, saturation: number) => Promise<void>;
    stats: () => Promise<EnginePlayerStats>;

    /**
     * Place the webcam box, in the screen recording's own pixels.
     *
     * The anchor grid and size ratios are resolved here and passed flattened,
     * so there is one placement formula in the app rather than two.
     */
    setWebcamLayout: (layout: EngineWebcamOverlay) => Promise<void>;
    /** Place the recording on the canvas: rect, corner radius, border. */
    setLayout: (placement: EngineVideoPlacement) => Promise<void>;
    /**
     * Set the zoom/pan timeline. The video and cursor move with it; the
     * background and webcam do not.
     */
    setZoomRegions: (regions: EngineZoomRegion[]) => Promise<void>;
    /**
     * Remove spans of the recording. Regions are in source time; the playhead
     * and duration reported afterwards are in composition time.
     */
    setCuts: (regions: EngineCutRegion[]) => Promise<void>;
    /** Throw away the edges of the recording. `null` keeps all of it. */
    setSourceCrop: (crop: EngineSourceCrop | null) => Promise<void>;
    /** The edit's length: the file's duration less what has been cut. */
    compositionDuration: () => Promise<number>;
    /** What fills the canvas behind the video. */
    setBackground: (background: EngineBackground) => Promise<void>;
    /** False when the recording had no camera track, or its sidecar would not open. */
    hasWebcam: () => Promise<boolean>;

    /** `pixels` must be an ArrayBuffer of tightly packed RGBA8. */
    setCursorImage: (image: EngineCursorBitmap | null) => Promise<void>;
    setCursorImages: (images: EngineCursorBitmap[]) => Promise<void>;
    setCursorTrack: (samples: EngineCursorPoint[]) => Promise<void>;
    /** Cursor height in destination pixels, and opacity. Size 0 hides it. */
    setCursorStyle: (size: number, opacity: number) => Promise<void>;
    /** The click pop and the smear, both resolved per frame against the track. */
    setCursorEffects: (effects: EngineCursorEffects) => Promise<void>;
    /** Spans of the composition to leave the camera out of. Composition time. */
    setWebcamCuts: (spans: EngineCutRegion[]) => Promise<void>;
    /** Which layer sits on top of which, bottom first. Empty means the default. */
    setLayerOrder: (order: string[]) => Promise<void>;
    /** Spans where the camera changes size, or expands to the whole frame. */
    setWebcamZoomRegions: (regions: EngineWebcamZoomRegion[]) => Promise<void>;
    /** Applied asynchronously, so this reads 0 for a moment after setCursorTrack. */
    cursorSampleCount: () => Promise<number>;
    /** Pointer bitmaps resident. Asynchronous like the sample count. */
    cursorImageCount: () => Promise<number>;

    /**
     * The composited frame as raw BGRA -- grading, webcam and cursor included.
     * Stalls the GPU; for stills and verification, not playback.
     */
    snapshot: () => Promise<{ width: number; height: number; pixels: ArrayBuffer } | null>;
  };

  export: {
    start: (input: string, options: EngineExportOptions) => Promise<{ output: string }>;
    progress: () => Promise<EngineExportProgress | null>;
    cancel: () => Promise<void>;
  };
}

interface ElectronAPI {
  window: {
    close: () => void;
    minimize: () => void;
    maximize: () => void;
    hideToTray: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
  };

  /**
   * A phone's camera, over the local network.
   *
   * The phone opens a page the desktop serves and posts frames back; they land
   * in the native recorder's frame slot, so the camera track is written on the
   * screen recording's own clock. Set `cameraSource: 'phone'` on the recording
   * config to actually use it.
   */
  phoneCamera: {
    /** Start serving the pairing page. Idempotent: returns the running session. */
    start: () => Promise<PhoneCameraSession>;
    stop: () => Promise<void>;
    /** Null when nothing is paired. Poll it while the pairing panel is open. */
    state: () => Promise<PhoneCameraState | null>;
    /** The newest JPEG from the phone, for showing its picture on the desktop. */
    frame: () => Promise<ArrayBuffer | null>;
  };

  recorder: {
    /** Get available screens and windows for recording */
    getSources: () => Promise<DesktopSource[]>;

    /**
     * Microphones as the native recorder sees them.
     *
     * Its ids go to `nativeMicDeviceId`. The browser's `enumerateDevices` ids
     * cannot: they are salted per origin and resolve to nothing in WASAPI.
     */
    listAudioCaptureDevices: () => Promise<
      Array<{ id: string; label: string; isDefault: boolean }>
    >;

    /** Start a new recording session */
    start: (config: RecordingConfig) => Promise<StartRecordingResult>;

    /** Stop the recording and save the file */
    stop: (recordingId: string) => Promise<StopRecordingResult>;

    /** Pause the active recording */
    pause: (recordingId: string) => void;

    /** Resume a paused recording */
    resume: (recordingId: string) => void;

    /** Get current recording state */
    getState: () => Promise<RecordingStateEvent>;

    /** Subscribe to recording state changes */
    onStateChange: (callback: (state: RecordingStateEvent) => void) => () => void;

    /** Get list of orphaned recordings from crashes */
    getOrphans: () => Promise<OrphanedRecording[]>;

    /** Recover an orphaned recording */
    recoverOrphan: (
      id: string,
      outputPath: string,
    ) => Promise<{ success: boolean; error?: string }>;

    /** Delete an orphaned recording */
    deleteOrphan: (id: string) => Promise<boolean>;

    /** Open native save dialog for recording */
    showSaveDialog: (defaultName: string) => Promise<string | null>;

    /** Open native directory picker */
    showOpenDialog: () => Promise<string | null>;

    /** Get default output directory (Videos folder) */
    getDefaultOutputDir: () => Promise<string>;

    /** Validate if output path is writable */
    validateOutputPath: (outputPath: string) => Promise<{ valid: boolean; error?: string }>;
  };

  compositor: {
    /** Get full compositor configuration */
    getConfig: () => Promise<{
      backgroundPath: string | null;
      backgroundColor: string;
      canvasSize: { width: number; height: number };
      canvasBackgroundEnabled: boolean;
    }>;

    /** Update compositor configuration (partial) */
    updateConfig: (updates: Record<string, unknown>) => Promise<{
      backgroundPath: string | null;
      backgroundColor: string;
      canvasSize: { width: number; height: number };
      canvasBackgroundEnabled: boolean;
    }>;

    /** Set background image path */
    setBackground: (imagePath: string | null) => Promise<boolean>;

    /** Get current background image path */
    getBackground: () => Promise<string | null>;

    /** Set background color (used when no image) */
    setBackgroundColor: (color: string) => Promise<boolean>;

    /** Get background color */
    getBackgroundColor: () => Promise<string>;

    /** Set target canvas size */
    setCanvasSize: (size: { width: number; height: number }) => Promise<boolean>;

    /** Get target canvas size */
    getCanvasSize: () => Promise<{ width: number; height: number }>;

    /** Calculate layout for webcam overlay on canvas */
    calculateWebcamLayout: (
      canvasSize?: { width: number; height: number },
      request?: {
        anchor?:
          | 'top-left'
          | 'top-center'
          | 'top-right'
          | 'center-left'
          | 'center'
          | 'center-right'
          | 'bottom-left'
          | 'bottom-center'
          | 'bottom-right';
        aspectRatio?: number;
        heightRatio?: number;
        marginPx?: number;
      },
    ) => Promise<{ x: number; y: number; width: number; height: number; scale: number }>;

    /** Reset configuration to defaults */
    resetConfig: () => Promise<{
      backgroundPath: string | null;
      backgroundColor: string;
      canvasSize: { width: number; height: number };
      canvasBackgroundEnabled: boolean;
    }>;

    /** Open file picker for background image */
    showBackgroundPicker: () => Promise<string | null>;
  };

  editor: {
    /** Create a new project from a recording ID */
    createProject: (recordingId: string) => Promise<Project | null>;

    /** Load an existing project from recording directory */
    loadProject: (recordingDir: string) => Promise<Project | null>;

    /** Save the active project to .recso folder */
    saveProject: () => Promise<boolean>;

    /** Get the active project */
    getProject: () => Promise<Project | null>;

    /** Close the active project */
    closeProject: () => Promise<boolean>;

    /** Get frame state at a specific time */
    getFrameState: (timeMs: number) => Promise<FrameState>;

    /** Get cursor position at a specific time */
    getCursorAt: (timeMs: number) => Promise<TransformedCursorPosition | null>;

    /** Update cursor configuration */
    updateCursorConfig: (config: Partial<CursorConfig>) => Promise<CursorConfig | undefined>;

    /** Upsert cursor image override for a timeline cursor region */
    updateCursorRegionOverride: (
      cursorOverride: CursorRegionOverride,
    ) => Promise<CursorRegionOverride[]>;

    /** Replace all cursor image overrides for timeline regions */
    replaceCursorRegionOverrides: (
      cursorOverrides: CursorRegionOverride[],
    ) => Promise<CursorRegionOverride[]>;

    /** Remove cursor image override for a timeline cursor region */
    removeCursorRegionOverride: (regionId: string) => Promise<CursorRegionOverride[]>;

    /** Open file picker for custom cursor image */
    showCursorPicker: () => Promise<string | null>;

    /** Update zoom configuration */
    updateZoomConfig: (config: Partial<ZoomConfig>) => Promise<ZoomConfig | undefined>;

    /** Update crop configuration for the source recording */
    updateCropConfig: (config: CropConfig | null) => Promise<CropConfig | null>;

    /** Update webcam overlay configuration */
    updateWebcamOverlay: (
      config: Partial<WebcamOverlayConfig>,
    ) => Promise<WebcamOverlayConfig | null | undefined>;

    /** Store the canvas padding (fraction of the canvas per side) on the project */
    updateCanvasPadding: (padding: number) => Promise<number | null>;

    /** Update project duration */
    updateProjectDuration: (durationMs: number) => Promise<boolean>;

    /** Check if a project exists for recording directory */
    projectExists: (recordingDir: string) => Promise<boolean>;

    /** Get spritesheet metadata */
    getSpritesheetMeta: () => Promise<SpritesheetMeta | null>;

    /** Get spritesheet image path */
    getSpritesheetPath: () => Promise<string | null>;

    /** Generate spritesheet for timeline thumbnails */
    generateSpritesheet: (intervalMs?: number) => Promise<SpritesheetMeta | null>;

    /** Get all cut regions */
    getCuts: () => Promise<CutRegion[]>;

    /** Add a new cut region */
    addCut: (cut: CutRegion) => Promise<boolean>;

    /** Remove a cut region by ID */
    removeCut: (cutId: string) => Promise<boolean>;

    /** Update a cut region */
    updateCut: (cut: CutRegion) => Promise<boolean>;

    /** Get timeline layers with visibility/order metadata */
    getTimelineLayers: () => Promise<TimelineLayer[]>;

    /** Update timeline layer visibility */
    updateTimelineLayerVisibility: (
      layerId: TimelineLayerId,
      visible: boolean,
    ) => Promise<TimelineLayer[] | null>;

    /** Update timeline layer hide mode */
    updateTimelineLayerHideMode: (
      layerId: TimelineLayerId,
      hideMode: TimelineVisibilityMode,
    ) => Promise<TimelineLayer[] | null>;

    /** Reorder timeline layers by ID */
    reorderTimelineLayers: (layerIds: TimelineLayerId[]) => Promise<TimelineLayer[] | null>;

    /** Get all zoom regions */
    getZoomRegions: () => Promise<ZoomRegion[]>;

    /** Get all zoom regions for a specific source timeline */
    getZoomRegionsBySource: (source: ZoomSource) => Promise<ZoomRegion[]>;

    /** Add a new zoom region */
    addZoomRegion: (zoom: ZoomRegion) => Promise<boolean>;

    /** Add a new zoom region for a specific source timeline */
    addZoomRegionBySource: (source: ZoomSource, zoom: ZoomRegion) => Promise<boolean>;

    /** Remove a zoom region by ID */
    removeZoomRegion: (zoomId: string) => Promise<boolean>;

    /** Remove a zoom region by ID for a specific source timeline */
    removeZoomRegionBySource: (source: ZoomSource, zoomId: string) => Promise<boolean>;

    /** Update a zoom region */
    updateZoomRegion: (zoom: ZoomRegion) => Promise<boolean>;

    /** Update a zoom region for a specific source timeline */
    updateZoomRegionBySource: (source: ZoomSource, zoom: ZoomRegion) => Promise<boolean>;

    /** Update multiple zoom regions at once (bulk) */
    updateZoomRegions: (zooms: ZoomRegion[]) => Promise<boolean>;

    /** Update multiple zoom regions for a specific source timeline (bulk) */
    updateZoomRegionsBySource: (source: ZoomSource, zooms: ZoomRegion[]) => Promise<boolean>;

    /** Get mouse events for the active project's recording */
    getMouseEvents: () => Promise<RecordedMouseEvent[]>;
  };

  background: {
    /** Update background color for the active project */
    updateColor: (color: string) => Promise<{ success: boolean; color: string }>;

    /** Update background path for the active project */
    updatePath: (path: string | null) => Promise<{ success: boolean; path: string | null }>;

    /** Update background pattern for the active project */
    updatePattern: (
      pattern: BackgroundPatternConfig | null,
    ) => Promise<{ success: boolean; pattern: BackgroundPatternConfig | null }>;

    /** Update active background mode for the project */
    updateMode: (
      mode: 'color' | 'pattern' | 'image',
    ) => Promise<{ success: boolean; mode: 'color' | 'pattern' | 'image' }>;

    /** Update whether canvas background is enabled */
    updateCanvasBackgroundEnabled: (
      enabled: boolean,
    ) => Promise<{ success: boolean; enabled: boolean }>;

    /** Get current background configuration */
    getConfig: () => Promise<{
      backgroundPath: string | null;
      backgroundColor: string;
      backgroundPattern: BackgroundPatternConfig | null;
      backgroundMode: 'color' | 'pattern' | 'image';
      canvasBackgroundEnabled: boolean;
    }>;
  };

  exporter: {
    /** Get exports folder path */
    getExportsFolder: () => Promise<string | null>;

    /** Open exports folder in file explorer */
    openExportsFolder: () => Promise<boolean>;

    /** Show file in folder */
    showInFolder: (filePath: string) => Promise<boolean>;

    /** Open file with the default system application */
    openFile: (filePath: string) => Promise<boolean>;

    /** Resolve output path using exporter naming rules */
    resolveOutputPath: (config: ExportConfig) => Promise<string | null>;

    /** How big a finished export is. 0 when the file is not there. */
    fileSize: (filePath: string) => Promise<number>;

    /** Persist renderer-produced output bytes to disk */
    writeOutputFile: (
      outputPath: string,
      data: ArrayBuffer,
    ) => Promise<{ success: boolean; outputPath?: string; fileSize?: number; error?: string }>;
  };

  telemetry: {
    /** Get the persistent hardware-based support ID for this device */
    getSupportId: () => Promise<string>;

    /** Send an error report from the renderer to the main process */
    logError: (error: {
      message: string;
      stack?: string;
      componentStack?: string;
      source?: string;
    }) => void;
  };

  recentProjects: {
    /** Get the most recently opened projects */
    getAll: (limit?: number) => Promise<RecentProject[]>;

    /** Remove a recent project entry by ID */
    remove: (id: string) => Promise<boolean>;

    /** Clear all recent projects */
    clear: () => Promise<boolean>;
  };

  logging: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };

  /**
   * GPU video engine. Always present as an object, but check
   * `status().available` before using it -- a checkout where the Rust was
   * never built reports false and every call below will throw.
   */
  engine: EngineAPI;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
