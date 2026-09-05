export interface DesktopSource {
  id: string;
  name: string;
  /** Thumbnail as base64 data URL */
  thumbnailDataUrl: string;
  /** Whether this source is a screen (vs window) */
  isScreen: boolean;
  /** Source origin X in global pixels */
  x?: number;
  /** Source origin Y in global pixels */
  y?: number;
  /** Monitor width in pixels */
  width?: number;
  /** Monitor height in pixels */
  height?: number;
  /** Whether this is the primary display */
  isPrimary?: boolean;
}

/** Mouse event recorded during a session */
export interface RecordedMouseEvent {
  id?: number;
  recordingId: string;
  timestampMs: number;
  /** Monitor-local cursor X in pixels (legacy field used for backward compatibility). */
  x: number;
  /** Monitor-local cursor Y in pixels (legacy field used for backward compatibility). */
  y: number;
  /** Cursor X normalized to 0..1 relative to the recorded area, when available. */
  normalizedX?: number;
  /** Cursor Y normalized to 0..1 relative to the recorded area, when available. */
  normalizedY?: number;
  /** Cursor image at this timestamp as a data URL snapshot (when available). */
  cursorDataUrl?: string;
  /** Hotspot X coordinate in source cursor image pixels. */
  cursorHotspotX?: number;
  /** Hotspot Y coordinate in source cursor image pixels. */
  cursorHotspotY?: number;
  /** Raw cursor handle (hex) captured from Win32 for identity tracking. */
  cursorHandleHex?: string;
  eventType: 'click' | 'mousemove';
  button?: 'left' | 'right' | 'middle';
}

export interface RecorderState {
  /**
   * `stopping` covers the finalize pass — flushing the native capture and
   * muxing desktop audio — which runs for seconds on a long take. It is a
   * distinct phase rather than a lingering `recording` so the UI can say so
   * instead of looking unresponsive.
   */
  status: 'idle' | 'recording' | 'paused' | 'stopping';
  recordingId: string | null;
  duration: number;
  bytesWritten: number;
}

export type RemoteCameraStatus = 'idle' | 'pairing' | 'connecting' | 'connected' | 'error';

export interface RemoteCameraState {
  status: RemoteCameraStatus;
  pairingUrl?: string;
  qrDataUrl?: string;
  expiresAt?: number;
  label?: string;
  error?: string;
}

export interface UseScreenRecorderOptions {
  /** Chunk interval in ms (default: 1000) */
  timeslice?: number;
  /** Include system audio */
  audio?: boolean;
}
// --- UI Types ---
export type PropertiesTab = 'general' | 'webcam' | 'cursor' | 'zoom' | 'export';

// --- Types mirrored from Backend ---

export interface RecordingOptions {
  videoBitrate?: number;
  audioBitrate?: number;
}

export interface RecordingConfig {
  sourceId: string;
  outputDir: string;
  fileName: string;
  /** File extension without dot (e.g., 'mp4'). Defaults to 'mp4' */
  fileExtension?: 'mp4' | 'mkv';
  /** Whether to record desktop/system audio */
  recordSystemAudio?: boolean;
  /** Whether to record from the camera as a separate file */
  recordCamera?: boolean;
  /** Whether to record microphone audio (embedded into video files) */
  recordMic?: boolean;
  /** Specific camera device ID (defaults to system default) */
  cameraDeviceId?: string;
  /**
   * Where the camera picture comes from. Defaults to a camera on this machine.
   *
   * `'phone'` needs a phone already paired and sending. There is no renderer
   * fallback for it, so starting a recording without one fails rather than
   * quietly using the laptop's own webcam instead.
   */
  cameraSource?: 'local' | 'phone';
  /** Specific microphone device ID (defaults to system default) */
  micDeviceId?: string;
  /** Recording engine mode. Defaults to legacy hybrid capture. */
  nativeCaptureMode?: 'legacy' | 'native-singular-clock';
  /** Target fps for native singular-clock capture path. */
  targetFps?: 30 | 60;
  /** Optional native webcam device id used by velocity v2 path. */
  nativeWebcamDeviceId?: string;
  options?: RecordingOptions;
}

export interface StartRecordingResult {
  success: boolean;
  recordingId?: string;
  tempPath?: string;
  /** True when webcam capture is handled fully in native velocity path. */
  nativeWebcamHandled?: boolean;
  /** True when that audio went into the recording's own track. */
  nativeSystemAudioHandled?: boolean;
  nativeMicrophoneHandled?: boolean;
  error?: string;
}

export interface StopRecordingResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

export interface OrphanedRecording {
  id: string;
  tempPath: string;
  fileName: string;
  startedAt: number;
  fileExists: boolean;
  fileSize: number;
  warning: string | null;
}

// --- Editor Types ---

export type CursorStyle = 'default' | 'pointer' | 'crosshair' | 'custom';
export type ZoomSource = 'screen' | 'webcam';
export type TimelineLayerId = 'main' | 'webcam' | 'zoom-screen' | 'zoom-webcam' | 'cursor';
export type TimelineVisibilityMode = 'editor-only' | 'render-and-export';

export interface TimelineLayer {
  id: TimelineLayerId;
  label: string;
  visible: boolean;
  order: number;
  hideMode: TimelineVisibilityMode;
}

export interface ZoomRegionsBySource {
  screen: ZoomRegion[];
  webcam: ZoomRegion[];
}

export interface CursorConfig {
  size: number;
  style: CursorStyle;
  customImagePath?: string;
  showClickAnimations: boolean;
  clickAnimationScale: number;
  clickDisplayDuration: number;
  showMotionBlur: boolean;
  motionBlurStrength: number;
}

export interface CursorRegionOverride {
  regionId: string;
  startMs: number;
  endMs: number;
  imagePath: string;
}

export interface ZoomConfig {
  level: number;
  focalX: number;
  focalY: number;
}

export interface TimelineClip {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  speed: number;
}

export interface TimelineTrack {
  id: string;
  type: 'video' | 'audio' | 'cursor';
  clips: TimelineClip[];
  enabled: boolean;
}

export interface Timeline {
  duration: number;
  tracks: TimelineTrack[];
}

export interface SpritesheetMeta {
  frameCount: number;
  intervalMs: number;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  totalDurationMs: number;
  imagePath: string;
}

/** A region of the video to be cut (excluded) from export */
export interface CutRegion {
  /** Unique identifier for the cut */
  id: string;
  /** Start time of the cut in milliseconds */
  startMs: number;
  /** End time of the cut in milliseconds */
  endMs: number;
  /** Optional lane-level inclusion state for screen/webcam timeline views. */
  targets?: {
    screen: boolean;
    webcam: boolean;
  };
}

/** A timestamped focal-point change within a zoom region */
export interface FocalKeyframe {
  /** Absolute time (ms from video start) when the focal point reaches this position */
  timestampMs: number;
  /** Focal point X (0-1, normalised to video area) */
  focalX: number;
  /** Focal point Y (0-1, normalised to video area) */
  focalY: number;
}

/** A region of the video where zoom is applied */
export interface ZoomRegion {
  /** Unique identifier for the zoom region */
  id: string;
  /** Start time of the zoom in milliseconds */
  startMs: number;
  /** End time of the zoom in milliseconds */
  endMs: number;
  /** Zoom level (1.0 = no zoom, 2.0 = 2x zoom, etc.) */
  zoomLevel: number;
  /** Initial / default focal point X (0.0 to 1.0, relative to canvas width) */
  focalX: number;
  /** Initial / default focal point Y (0.0 to 1.0, relative to canvas height) */
  focalY: number;
  /** Duration of ease in/out animation in milliseconds */
  easeDurationMs: number;
  /** Optional webcam canvas height override (0-1) for webcam zoom timelines. */
  webcamHeightRatio?: number;
  /** Optional full-canvas webcam mode for webcam zoom timelines. */
  webcamFullScreen?: boolean;
  /**
   * Optional focal-point keyframes produced by smart pan.
   * When present the renderer interpolates between them instead of
   * using the static focalX/focalY for the whole region.
   * Sorted by timestampMs ascending.
   */
  focalKeyframes?: FocalKeyframe[];
}

/** 3x3 placement grid for the webcam overlay. */
export type WebcamOverlayAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';
export type WebcamOverlayShape = 'circle' | 'rectangle-landscape' | 'rectangle-portrait' | 'square';
export type WebcamOverlaySize = 'small' | 'medium' | 'large';

export interface WebcamShadowLayer {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
}

export interface WebcamOverlayConfig {
  enabled: boolean;
  sourcePath?: string;
  anchor?: WebcamOverlayAnchor;
  shape?: WebcamOverlayShape;
  size?: WebcamOverlaySize;
  aspectRatio?: number;
  heightRatio?: number;
  marginPx?: number;
  borderRadiusPx?: number;
  borderWidthPx?: number;
  borderColor?: string;
  opacity?: number;
  shadows?: WebcamShadowLayer[];
}

/** Crop configuration — normalised 0–1 insets from each edge of the source video. */
export interface CropConfig {
  /** Fraction cropped from the top (0 = no crop, 0.25 = crop 25 % from top) */
  top: number;
  /** Fraction cropped from the left */
  left: number;
  /** Fraction cropped from the bottom */
  bottom: number;
  /** Fraction cropped from the right */
  right: number;
}

import type { BackgroundPatternConfig } from '../shared/patterns';

export type BackgroundMode = 'color' | 'pattern' | 'image';

export interface Project {
  id: string;
  name: string;
  recordingId: string;
  projectFolderPath: string;
  rawVideoPath: string;
  videoDimensions: {
    width: number;
    height: number;
  };
  timeline: Timeline;
  cursorConfig: CursorConfig;
  cursorRegionOverrides?: CursorRegionOverride[];
  zoomConfig: ZoomConfig;
  spritesheetMeta: SpritesheetMeta | null;
  backgroundPath?: string;
  backgroundColor: string;
  backgroundPattern?: BackgroundPatternConfig | null;
  backgroundMode?: BackgroundMode;
  canvasBackgroundEnabled?: boolean;
  /** Padding kept clear on each side of the canvas, as a fraction of the canvas (0–0.25) */
  canvasPadding?: number;
  /** Optional crop configuration for the source recording */
  cropConfig?: CropConfig | null;
  webcamOverlay?: WebcamOverlayConfig | null;
  cuts: CutRegion[];
  /** Legacy screen zoom regions. Prefer zoomRegionsBySource.screen for new code. */
  zoomRegions: ZoomRegion[];
  zoomRegionsBySource?: ZoomRegionsBySource;
  timelineLayers?: TimelineLayer[];
  createdAt: number;
  modifiedAt: number;
}

export interface TransformedCursorPosition {
  x: number;
  y: number;
  visible: boolean;
  eventType: 'click';
  button?: string;
  isInterpolated: boolean;
  fadeProgress?: number;
}

export interface FrameState {
  timeMs: number;
  cursor: TransformedCursorPosition | null;
}

// --- Exporter Types ---

/** Supported output resolutions */
export type ExportResolution = '720p' | '1080p' | '4k' | 'custom';

/** Supported output formats */
export type ExportFormat = 'mp4';

/** Quality presets */
export type ExportQuality = 'low' | 'medium' | 'high' | 'lossless';

/** Supported frame rates */
export type ExportFPS = 24 | 30 | 60;

/** GL renderer backends for GPU acceleration */
export type GLRenderer =
  | null
  | 'angle'
  | 'egl'
  | 'swiftshader'
  | 'vulkan'
  | 'angle-egl'
  | 'swangle';

/** Export configuration from UI */
export interface ExportConfig {
  /** Target resolution preset */
  resolution: ExportResolution;
  /** Custom width (only used when resolution is 'custom') */
  customWidth?: number;
  /** Custom height (only used when resolution is 'custom') */
  customHeight?: number;
  /** Output format */
  format: ExportFormat;
  /** Quality preset */
  quality: ExportQuality;
  /** Target frame rate */
  fps: ExportFPS;
  /** Background color from editor (hex) */
  backgroundColor: string;
  /** Optional explicit output folder path */
  outputFolder?: string;
  /** Optional explicit output filename */
  outputFilename?: string;
  /** GL renderer backend for GPU acceleration */
  glRenderer?: GLRenderer;
}

/** Export progress event */
export interface ExportProgress {
  /** Progress percentage (0-100) */
  percent: number;
  /** Current frame being processed */
  currentFrame: number;
  /** Total frames in video */
  totalFrames: number;
  /** Current encoding speed in fps */
  fps: number;
  /** Estimated seconds remaining */
  eta: number;
  /** Current export stage */
  stage: 'composition' | 'export';
  /** Progress percentage of the current stage (0-100) */
  stagePercent: number;
  /**
   * What is happening right now, for the user rather than for arithmetic.
   *
   * The last third of an export is a handful of operations that cannot report
   * their own progress -- rendering the mixed audio in one shot, writing the
   * container -- so the percentage sits still through them. A number that has
   * stopped moving reads as a hang; a label saying "Mixing audio" reads as
   * work.
   */
  phase: string;
  /**
   * True while the current phase cannot report incremental progress.
   *
   * The bar should animate rather than sit at a number it is not actually
   * making its way towards.
   */
  indeterminate: boolean;
}

/** Export result */
export interface ExportResult {
  /** Whether export completed successfully */
  success: boolean;
  /** Path to exported file (on success) */
  outputPath?: string;
  /** Video duration in seconds */
  duration?: number;
  /** File size in bytes */
  fileSize?: number;
  /** Error message (on failure) */
  error?: string;
}

/** Export job state */
export type ExportState = 'idle' | 'exporting' | 'cancelled' | 'completed' | 'error';
