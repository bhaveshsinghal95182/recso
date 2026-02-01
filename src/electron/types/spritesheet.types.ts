/**
 * Spritesheet Types for Timeline Thumbnails
 *
 * A spritesheet is a single PNG containing multiple video thumbnails
 * arranged in a grid. Used for efficient timeline scrubbing.
 */

/**
 * Metadata describing a spritesheet's structure
 */
export interface SpritesheetMeta {
  /** Total number of frames in the spritesheet */
  frameCount: number;
  /** Interval between frames in milliseconds (e.g., 1000ms = 1 frame/second) */
  intervalMs: number;
  /** Width of each frame in pixels */
  frameWidth: number;
  /** Height of each frame in pixels */
  frameHeight: number;
  /** Number of frames per row in the spritesheet */
  columns: number;
  /** Number of rows in the spritesheet */
  rows: number;
  /** Total video duration in milliseconds */
  totalDurationMs: number;
  /** Path to the spritesheet image file */
  imagePath: string;
}

/**
 * Default spritesheet configuration
 */
export const DEFAULT_SPRITESHEET_CONFIG = {
  /** Interval between frames (1 second) */
  intervalMs: 1000,
  /** Target frame width */
  frameWidth: 160,
  /** Target frame height (16:9 aspect ratio) */
  frameHeight: 90,
  /** Max frames per row */
  maxColumns: 10,
};

/**
 * Get frame coordinates in spritesheet for a given time
 */
export function getFrameCoordinates(
  meta: SpritesheetMeta,
  timeMs: number,
): { x: number; y: number; width: number; height: number } | null {
  if (timeMs < 0 || timeMs > meta.totalDurationMs) {
    return null;
  }

  const frameIndex = Math.floor(timeMs / meta.intervalMs);
  if (frameIndex >= meta.frameCount) {
    return null;
  }

  const col = frameIndex % meta.columns;
  const row = Math.floor(frameIndex / meta.columns);

  return {
    x: col * meta.frameWidth,
    y: row * meta.frameHeight,
    width: meta.frameWidth,
    height: meta.frameHeight,
  };
}
