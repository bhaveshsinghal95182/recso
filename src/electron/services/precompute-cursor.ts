/**
 * Precompute Cursor Frames
 *
 * Converts raw mouse events from SQLite into a flat, frame-indexed array
 * for O(1) lookups during Remotion rendering. This is the key performance
 * optimization — all heavy math (interpolation, blip animation, cut mapping)
 * happens once before the render starts.
 *
 * Input:  Raw MouseEvent[] from mouse_events table (sparse, ~20Hz)
 * Output: PrecomputedCursorFrame[] indexed by Remotion frame number
 */

import type { MouseEvent } from './mouse-tracker.service.js';

// ─── Types ───────────────────────────────────────────────────────────────

export interface PrecomputedCursorFrame {
  /** X position in canvas-space pixels */
  x: number;
  /** Y position in canvas-space pixels */
  y: number;
  /** Scale factor (1.0 = normal, dips on click for "blip") */
  scale: number;
  /** Opacity (0-1) */
  opacity: number;
  /** Whether this frame is during a click event */
  isClick: boolean;
}

export interface PrecomputeOptions {
  /** Frames per second of the composition */
  fps: number;
  /** Total number of frames in the composition */
  totalFrames: number;
  /** Original video dimensions (pixels) */
  videoDimensions: { width: number; height: number };
  /** Canvas/composition dimensions (pixels) */
  canvasDimensions: { width: number; height: number };
  /** Layout positioning of the video on the canvas */
  layout: { x: number; y: number; width: number; height: number; scale: number };
  /** Duration of the source video in milliseconds */
  sourceDurationMs: number;
  /** Cut regions (source timeline, milliseconds) */
  cuts?: Array<{ startMs: number; endMs: number }>;
  /** Number of frames for the click blip animation (default: 8) */
  blipDurationFrames?: number;
  /** Minimum scale during click blip (default: 0.7) */
  blipMinScale?: number;
  /**
   * Border width of the VideoLayer container (default: 8).
   * VideoLayer uses `boxSizing: border-box` so the actual video content
   * is inset by this amount on all sides.
   */
  videoBorderWidth?: number;
}

// ─── Cut-region helpers (mirrors remotion/cut-utils, but runs in main process) ──

interface UncutSegment {
  sourceStartMs: number;
  sourceEndMs: number;
  compositionStartMs: number;
  durationMs: number;
}

function getUncutSegments(
  cuts: Array<{ startMs: number; endMs: number }> | undefined,
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

  const sorted = [...cuts].sort((a, b) => a.startMs - b.startMs);
  const merged: { startMs: number; endMs: number }[] = [];

  for (const cut of sorted) {
    const last = merged[merged.length - 1];
    if (last && cut.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, cut.endMs);
    } else {
      merged.push({ startMs: cut.startMs, endMs: cut.endMs });
    }
  }

  const segments: UncutSegment[] = [];
  let cursor = 0;
  let compositionCursor = 0;

  for (const cut of merged) {
    if (cut.startMs > cursor) {
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
 * Map composition time → source time (accounting for cuts).
 */
function compositionToSourceTime(compositionTimeMs: number, segments: UncutSegment[]): number {
  for (const seg of segments) {
    const segEnd = seg.compositionStartMs + seg.durationMs;
    if (compositionTimeMs < segEnd) {
      const offset = compositionTimeMs - seg.compositionStartMs;
      return seg.sourceStartMs + offset;
    }
  }
  const last = segments[segments.length - 1];
  return last ? last.sourceEndMs : 0;
}

// ─── Easing ──────────────────────────────────────────────────────────────

/**
 * Ease-out cubic: fast start, smooth deceleration.
 * Used for click blip recovery so the cursor snaps down and glides back.
 */
function easeOutCubic(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - c, 3);
}

// ─── Main Precomputation ─────────────────────────────────────────────────

/**
 * Precompute cursor frame data from raw mouse events.
 *
 * Returns a flat array where array[frameIndex] gives the cursor state
 * for that Remotion frame. This allows O(1) lookups during rendering.
 *
 * @param events - Raw mouse events from the database, sorted by timestampMs
 * @param options - Composition and layout parameters
 * @returns Array of PrecomputedCursorFrame indexed by frame number
 */
export function precomputeCursorFrames(
  events: MouseEvent[],
  options: PrecomputeOptions,
): PrecomputedCursorFrame[] {
  const {
    fps,
    totalFrames,
    videoDimensions,
    layout,
    sourceDurationMs,
    cuts,
    blipDurationFrames = 8,
    blipMinScale = 0.7,
    videoBorderWidth = 8,
  } = options;

  if (events.length === 0 || totalFrames <= 0) {
    return [];
  }

  // Build cut segments for time mapping
  const segments = getUncutSegments(cuts, sourceDurationMs);
  const hasCuts = cuts && cuts.length > 0;

  // Separate click events for blip processing
  const clickTimestamps = new Set<number>();
  for (const e of events) {
    if (e.eventType === 'click') {
      clickTimestamps.add(e.timestampMs);
    }
  }

  // IMPORTANT: VideoLayer uses `boxSizing: border-box` with a border,
  // so the actual video content area is inset from the layout rect.
  // The video content occupies:
  //   x: layout.x + borderWidth
  //   y: layout.y + borderWidth
  //   width: layout.width - 2 * borderWidth
  //   height: layout.height - 2 * borderWidth
  const contentX = layout.x + videoBorderWidth;
  const contentY = layout.y + videoBorderWidth;
  const contentWidth = layout.width - 2 * videoBorderWidth;
  const contentHeight = layout.height - 2 * videoBorderWidth;

  // Mouse events store normalized 0-1 ratios, so mapping to canvas is simple:
  //   canvasX = contentX + ratio * contentWidth
  //   canvasY = contentY + ratio * contentHeight
  // No need for videoDimensions or scale factors — ratios are resolution-independent.

  // Convert normalized events to canvas-space position snapshots
  interface CursorSnapshot {
    sourceTimeMs: number;
    canvasX: number;
    canvasY: number;
    isClick: boolean;
  }

  const snapshots: CursorSnapshot[] = events.map((e) => ({
    sourceTimeMs: e.timestampMs,
    canvasX: contentX + e.x * contentWidth,
    canvasY: contentY + e.y * contentHeight,
    isClick: e.eventType === 'click',
  }));

  // ── Build per-frame data ──

  const frames: PrecomputedCursorFrame[] = new Array(totalFrames);
  const msPerFrame = 1000 / fps;

  for (let frame = 0; frame < totalFrames; frame++) {
    // Composition time for this frame
    const compositionTimeMs = frame * msPerFrame;

    // Map to source time (accounting for cuts)
    const sourceTimeMs = hasCuts
      ? compositionToSourceTime(compositionTimeMs, segments)
      : compositionTimeMs;

    // Find the two bracketing snapshots for interpolation
    const { x, y } = interpolatePosition(snapshots, sourceTimeMs);

    frames[frame] = {
      x,
      y,
      scale: 1.0,
      opacity: 1.0,
      isClick: false,
    };
  }

  // ── Bake click blips into the scale field ──

  // For each click event, find the corresponding composition frame and
  // apply a scale animation over blipDurationFrames
  for (const e of events) {
    if (e.eventType !== 'click') continue;

    // Find the composition frame for this click's source timestamp
    const clickFrame = sourceTimeToFrame(e.timestampMs, segments, hasCuts, fps, msPerFrame);

    if (clickFrame < 0 || clickFrame >= totalFrames) continue;

    // Apply blip: scale down then back to 1.0 over blipDurationFrames
    for (
      let offset = 0;
      offset < blipDurationFrames && clickFrame + offset < totalFrames;
      offset++
    ) {
      const frameIdx = clickFrame + offset;
      const progress = offset / (blipDurationFrames - 1); // 0 → 1
      const eased = easeOutCubic(progress);

      // Scale goes from blipMinScale → 1.0
      const blipScale = blipMinScale + (1.0 - blipMinScale) * eased;

      // Only apply if this produces a smaller scale (don't clobber an existing blip
      // from a nearby click that's still recovering)
      if (blipScale < frames[frameIdx].scale) {
        frames[frameIdx].scale = blipScale;
      }
      frames[frameIdx].isClick = true;
    }
  }

  return frames;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Binary search for the snapshot just before or at the given source time.
 * Returns the index of the last snapshot with sourceTimeMs <= targetTime.
 */
function findSnapshotIndex(snapshots: Array<{ sourceTimeMs: number }>, targetTime: number): number {
  let lo = 0;
  let hi = snapshots.length - 1;
  let result = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (snapshots[mid].sourceTimeMs <= targetTime) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return result;
}

/**
 * Linearly interpolate cursor position between two bracketing snapshots.
 */
function interpolatePosition(
  snapshots: Array<{ sourceTimeMs: number; canvasX: number; canvasY: number }>,
  sourceTimeMs: number,
): { x: number; y: number } {
  if (snapshots.length === 0) {
    return { x: 0, y: 0 };
  }

  const idx = findSnapshotIndex(snapshots, sourceTimeMs);

  // Before any snapshot — use first position
  if (idx < 0) {
    return { x: snapshots[0].canvasX, y: snapshots[0].canvasY };
  }

  // At or past the last snapshot — use last position
  if (idx >= snapshots.length - 1) {
    return { x: snapshots[idx].canvasX, y: snapshots[idx].canvasY };
  }

  // Lerp between snapshots[idx] and snapshots[idx+1]
  const a = snapshots[idx];
  const b = snapshots[idx + 1];
  const range = b.sourceTimeMs - a.sourceTimeMs;

  if (range <= 0) {
    return { x: a.canvasX, y: a.canvasY };
  }

  const t = (sourceTimeMs - a.sourceTimeMs) / range;

  return {
    x: a.canvasX + (b.canvasX - a.canvasX) * t,
    y: a.canvasY + (b.canvasY - a.canvasY) * t,
  };
}

/**
 * Convert a source timestamp to a composition frame index.
 * Accounts for cut regions by mapping source → composition time.
 */
function sourceTimeToFrame(
  sourceTimeMs: number,
  segments: UncutSegment[],
  hasCuts: boolean | undefined,
  fps: number,
  msPerFrame: number,
): number {
  if (!hasCuts) {
    return Math.round(sourceTimeMs / msPerFrame);
  }

  // Map source time to composition time
  for (const seg of segments) {
    if (sourceTimeMs >= seg.sourceStartMs && sourceTimeMs < seg.sourceEndMs) {
      const offset = sourceTimeMs - seg.sourceStartMs;
      const compositionTimeMs = seg.compositionStartMs + offset;
      return Math.round(compositionTimeMs / msPerFrame);
    }
  }

  // Source time is inside a cut region — skip it
  return -1;
}
