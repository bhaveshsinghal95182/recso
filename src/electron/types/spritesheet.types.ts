/**
 * Spritesheet Types for Timeline Thumbnails
 *
 * A spritesheet is a single PNG containing multiple video thumbnails
 * arranged in a grid. Used for efficient timeline scrubbing.
 */

/** Which of a recording's two video files a sheet was built from. */
export type SpritesheetSource = 'screen' | 'webcam';

/**
 * Metadata describing a spritesheet's structure
 */
export interface SpritesheetMeta {
  /** Which video this sheet was built from */
  source: SpritesheetSource;
  /**
   * Size and mtime of that video when the sheet was built.
   *
   * A recording is immutable once muxed, so these almost never change — but a
   * project recovered after a crash and re-muxed does change, and a sheet of
   * the old file would be thumbnails of footage that is no longer there.
   */
  sourceSizeBytes: number;
  sourceModifiedMs: number;
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
 * The sheets a project has, by source. A source is absent until its sheet has
 * finished generating, which is why every reader has to cope with a missing one.
 */
export type SpritesheetsBySource = Partial<Record<SpritesheetSource, SpritesheetMeta>>;

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
