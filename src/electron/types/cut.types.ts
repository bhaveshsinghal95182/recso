/**
 * Cut Types
 *
 * Defines the structure for cut regions used to exclude
 * sections from the exported video.
 */

/**
 * A region of the video to be cut (excluded) from export
 */
export interface CutRegion {
  /** Unique identifier for the cut */
  id: string;
  /** Start time of the cut in milliseconds */
  startMs: number;
  /** End time of the cut in milliseconds */
  endMs: number;
}
