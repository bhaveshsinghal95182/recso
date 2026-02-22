/**
 * Cut Utilities for Remotion Composition
 *
 * Provides time-mapping functions that translate between the shortened
 * (post-cut) composition timeline and the original source video timeline.
 *
 * The key idea:
 *   - Cuts remove segments from the video.
 *   - Remotion renders fewer frames (durationInFrames is shorter).
 *   - Each composition frame maps to a specific source-video timestamp,
 *     skipping over cut regions.
 *
 * Example:
 *   Source video: 0──────10s (10s total)
 *   Cut region:  3s──5s  (2s cut)
 *   Composition: 0──3s + 5s──10s = 8s total
 *
 *   compositionTimeMs=4000 → sourceTimeMs=6000
 *   (4s into the shortened video = 3s before cut + 1s after the 2s gap)
 */

import type { CompositionCutRegion } from './types';

/** A segment of the source video that is NOT cut */
export interface UncutSegment {
  /** Start time in the source video (ms) */
  sourceStartMs: number;
  /** End time in the source video (ms) */
  sourceEndMs: number;
  /** Start time in the composition timeline (ms) */
  compositionStartMs: number;
  /** Duration of this segment (ms) */
  durationMs: number;
}

/**
 * Convert cut regions into an ordered list of uncut (kept) segments.
 *
 * @param cuts - Cut regions to exclude (will be sorted internally)
 * @param sourceDurationMs - Total duration of the source video in ms
 * @returns Array of uncut segments, ordered by source time
 */
export function getUncutSegments(
  cuts: CompositionCutRegion[] | undefined,
  sourceDurationMs: number,
): UncutSegment[] {
  if (!cuts || cuts.length === 0) {
    return [
      {
        sourceStartMs: 0,
        sourceEndMs: sourceDurationMs,
        compositionStartMs: 0,
        durationMs: sourceDurationMs,
      },
    ];
  }

  // Sort cuts by start time and merge overlapping
  const sorted = [...cuts].sort((a, b) => a.startMs - b.startMs);
  const merged: { startMs: number; endMs: number }[] = [];

  for (const cut of sorted) {
    const last = merged[merged.length - 1];
    if (last && cut.startMs <= last.endMs) {
      // Overlapping or adjacent — extend
      last.endMs = Math.max(last.endMs, cut.endMs);
    } else {
      merged.push({ startMs: cut.startMs, endMs: cut.endMs });
    }
  }

  // Build uncut segments from the gaps between cuts
  const segments: UncutSegment[] = [];
  let cursor = 0; // current position in source timeline
  let compositionCursor = 0; // current position in composition timeline

  for (const cut of merged) {
    if (cut.startMs > cursor) {
      // There's an uncut segment before this cut
      const durationMs = cut.startMs - cursor;
      segments.push({
        sourceStartMs: cursor,
        sourceEndMs: cut.startMs,
        compositionStartMs: compositionCursor,
        durationMs,
      });
      compositionCursor += durationMs;
    }
    cursor = cut.endMs;
  }

  // Final segment after the last cut
  if (cursor < sourceDurationMs) {
    const durationMs = sourceDurationMs - cursor;
    segments.push({
      sourceStartMs: cursor,
      sourceEndMs: sourceDurationMs,
      compositionStartMs: compositionCursor,
      durationMs,
    });
  }

  return segments;
}

/**
 * Map a composition time (shortened timeline) back to the original source time.
 *
 * @param compositionTimeMs - Time in the shortened composition (ms)
 * @param segments - Precomputed uncut segments from getUncutSegments()
 * @returns The corresponding source video time in ms
 */
export function compositionToSourceTime(
  compositionTimeMs: number,
  segments: UncutSegment[],
): number {
  for (const seg of segments) {
    const segEnd = seg.compositionStartMs + seg.durationMs;
    if (compositionTimeMs < segEnd) {
      const offset = compositionTimeMs - seg.compositionStartMs;
      return seg.sourceStartMs + offset;
    }
  }

  // Past the end — return the end of the last segment
  const last = segments[segments.length - 1];
  return last ? last.sourceEndMs : 0;
}

/**
 * Calculate the total duration of the composition after cuts.
 *
 * @param cuts - Cut regions
 * @param sourceDurationMs - Source video duration in ms
 * @returns Duration of the composition in ms (source minus cut durations)
 */
export function getCompositionDurationMs(
  cuts: CompositionCutRegion[] | undefined,
  sourceDurationMs: number,
): number {
  if (!cuts || cuts.length === 0) return sourceDurationMs;

  const segments = getUncutSegments(cuts, sourceDurationMs);
  return segments.reduce((sum, seg) => sum + seg.durationMs, 0);
}
