export interface DesktopSource {
  id: string;
  name: string;
  /** Thumbnail as base64 data URL */
  thumbnailDataUrl: string;
  /** Whether this source is a screen (vs window) */
  isScreen: boolean;
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
  x: number;
  y: number;
  eventType: 'click' | 'mousemove';
  button?: 'left' | 'right' | 'middle';
}

export interface RecorderState {
  status: 'idle' | 'recording' | 'paused';
  recordingId: string | null;
  duration: number;
  bytesWritten: number;
}

export interface UseScreenRecorderOptions {
  /** Chunk interval in ms (default: 1000) */
  timeslice?: number;
  /** Include system audio */
  audio?: boolean;
}
// --- UI Types ---
export type PropertiesTab = 'general' | 'zoom' | 'pattern' | 'export';

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
  /** Specific microphone device ID (defaults to system default) */
  micDeviceId?: string;
  options?: RecordingOptions;
}

export interface StartRecordingResult {
  success: boolean;
  recordingId?: string;
  tempPath?: string;
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

export interface CursorConfig {
  size: number;
  style: CursorStyle;
  customImagePath?: string;
  showClickAnimations: boolean;
  clickAnimationScale: number;
  clickDisplayDuration: number;
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
  /**
   * Optional focal-point keyframes produced by smart pan.
   * When present the renderer interpolates between them instead of
   * using the static focalX/focalY for the whole region.
   * Sorted by timestampMs ascending.
   */
  focalKeyframes?: FocalKeyframe[];
}

import type { BackgroundPatternConfig } from '../shared/patterns';

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
  zoomConfig: ZoomConfig;
  spritesheetMeta: SpritesheetMeta | null;
  backgroundPath?: string;
  backgroundColor: string;
  backgroundPattern?: BackgroundPatternConfig | null;
  cuts: CutRegion[];
  zoomRegions: ZoomRegion[];
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
