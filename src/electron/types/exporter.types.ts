/**
 * Exporter Types
 * Defines interfaces for video export configuration and progress tracking.
 */

/** Supported output resolutions */
export type ExportResolution = '720p' | '1080p' | '4k' | 'custom';

/** Supported output formats */
export type ExportFormat = 'mp4';

/** Quality presets */
export type ExportQuality = 'low' | 'medium' | 'high' | 'lossless';

/** Supported frame rates */
export type ExportFPS = 24 | 30 | 60;

/**
 * GL renderer backends for Chromium/Remotion video rendering.
 *
 * Recommendations:
 * - null: Default, lets Chrome decide (recommended for most cases)
 * - angle: Recommended for WebGL/Three.js on desktop with GPU
 * - angle-egl: Recommended for cloud instances with GPU
 * - swangle: Recommended for Lambda or machines without GPU (slower)
 * - swiftshader: Software rendering fallback
 * - vulkan: Vulkan backend (requires Remotion v4.0.41+)
 * - egl: EGL backend
 */
export type GLRenderer =
  | null
  | 'angle'
  | 'egl'
  | 'swiftshader'
  | 'vulkan'
  | 'angle-egl'
  | 'swangle';

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
  low: 20, // Was 28 - reduced for better quality
  medium: 16, // Was 23 - reduced for better quality
  high: 12, // Was 18 - reduced for much better quality
  lossless: 10, // Visually lossless (CRF 0 causes H264 platform issues)
};

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
  /**
   * GL renderer backend for Chromium/Remotion.
   * Controls GPU usage during video composition.
   * - null: Let Chrome decide (default)
   * - angle: Use GPU on desktop (recommended for WebGL)
   * - angle-egl: Use GPU on cloud/Linux
   * - swangle: Software rendering (no GPU required)
   */
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
  glRenderer: 'angle', // Use GPU acceleration (ANGLE backend for best performance with NVIDIA)
};
