/**
 * Remotion Service Types
 *
 * Type definitions for Remotion composition rendering.
 * These types bridge between the Electron backend and Remotion's rendering API.
 */

/**
 * Progress event during Remotion rendering.
 *
 * Emitted by Remotion for each frame rendered.
 * Includes current frame count and encoding status.
 */
export interface RemotionRenderProgress {
  /** Number of frames rendered so far */
  renderedFrames: number;

  /** Total frames to render */
  totalFrames: number;

  /** Progress percentage (0-100) */
  percent: number;

  /** Number of frames encoded (may lag behind rendered) */
  encodedFrames: number;

  /** Time when encoding finished in milliseconds (null if still encoding) */
  encodedDoneIn: number | null;
}

/**
 * Result of a Remotion render operation.
 *
 * Indicates success/failure and provides output path or error message.
 */
export interface RemotionRenderResult {
  /** Whether rendering completed successfully */
  success: boolean;

  /** Path to output file (on success) */
  outputPath?: string;

  /** Error message (on failure) */
  error?: string;

  /** Video duration in seconds */
  duration?: number;

  /** FPS used for the intermediate render (source video FPS) */
  sourceFps?: number;
}

/**
 * Remotion composition input props.
 *
 * Data passed to the Remotion composition during rendering.
 * Includes project data, configuration, and layout information.
 *
 * This type should match what MainComposition expects in src/remotion/Composition.tsx
 */
export interface RemotionInputProps {
  /** Project data with video metadata */
  project: any;

  /** Export configuration (resolution, codec, fps, etc.) */
  config: any;

  /** Layout calculations (scaled positions, sizes) */
  layout: any;

  /** Canvas width in pixels */
  canvasWidth: number;

  /** Canvas height in pixels */
  canvasHeight: number;
}
