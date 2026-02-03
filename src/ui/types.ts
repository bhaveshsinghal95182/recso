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

// --- Types mirrored from Backend ---

export interface RecordingOptions {
  videoBitrate?: number;
  audioBitrate?: number;
}

export interface RecordingConfig {
  sourceId: string;
  outputDir: string;
  fileName: string;
  /** File extension without dot (e.g., 'mp4', 'webm'). Defaults to 'webm' */
  fileExtension?: 'mp4' | 'webm';
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

export interface Statistics {
  cpu: number;
  ram: number;
  storage: number;
}

export interface StaticData {
  totalStorage: number;
  cpuModel: string;
  totalRAM: number;
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
export type ExportFormat = 'mp4' | 'webm';

/** Quality presets */
export type ExportQuality = 'low' | 'medium' | 'high' | 'lossless';

/** Supported frame rates */
export type ExportFPS = 24 | 30 | 60;

/** Export configuration from UI */
export interface ExportConfig {
  /** Target resolution preset */
  resolution: ExportResolution;
  /** Custom width (only used when resolution is 'custom') */
  customWidth?: number;
  /** Custom height (only used when resolution is 'custom') */
  customHeight?: number;
  /** Output format (mp4 or webm) */
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
