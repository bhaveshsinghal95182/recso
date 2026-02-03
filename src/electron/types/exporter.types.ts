/**
 * Exporter Types
 * Defines interfaces for video export configuration and progress tracking.
 */

/** Supported output resolutions */
export type ExportResolution = '720p' | '1080p' | '4k' | 'custom';

/** Supported output formats */
export type ExportFormat = 'mp4' | 'webm';

/** Quality presets */
export type ExportQuality = 'low' | 'medium' | 'high' | 'lossless';

/** Supported frame rates */
export type ExportFPS = 24 | 30 | 60;

/** Resolution dimensions lookup */
export const RESOLUTION_MAP: Record<
  Exclude<ExportResolution, 'custom'>,
  { width: number; height: number }
> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
};

/** Quality to CRF mapping (lower = better quality, bigger file) */
export const QUALITY_CRF_MAP: Record<ExportQuality, number> = {
  low: 28,
  medium: 23,
  high: 18,
  lossless: 0,
};

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

/** Internal export job tracking */
export interface ExportJob {
  /** Unique job ID */
  id: string;
  /** Project ID being exported */
  projectId: string;
  /** Current job state */
  state: ExportState;
  /** Export configuration */
  config: ExportConfig;
  /** Output file path */
  outputPath: string;
  /** Current progress */
  progress: ExportProgress;
  /** Job start timestamp */
  startedAt: number;
  /** Error message if failed */
  error?: string;
}

/** Default export configuration */
export const DEFAULT_EXPORT_CONFIG: ExportConfig = {
  resolution: '1080p',
  format: 'mp4',
  quality: 'high',
  fps: 30,
  backgroundColor: '#000000',
};
