import { MIN_REGION_DURATION_MS, VIEWPORT_PADDING } from '@/constants';
import type { RecordedMouseEvent, ZoomRegion } from '@/types';
/**
 * Given a zoom region and a set of mouse-move events, split the region into
 * sub-regions whenever the mouse leaves the visible viewport.
 *
 * Viewport math:
 *   At zoomLevel `z` with focal point `(fx, fy)` (both 0-1),
 *   the visible rectangle in normalised coords is:
 *     halfW = 0.5 / z
 *     halfH = 0.5 / z
 *     left  = fx - halfW,  right  = fx + halfW
 *     top   = fy - halfH,  bottom = fy + halfH
 *
 *   When the mouse (mx, my) moves outside this rect (with VIEWPORT_PADDING)
 *   we end the current sub-region and start a new one centred on the mouse.
 */
export function smartPanSingleRegion(
  region: ZoomRegion,
  moves: RecordedMouseEvent[],
  videoWidth: number,
  videoHeight: number,
): ZoomRegion[] {
  // Filter moves that fall within this region's time span
  const regionMoves = moves.filter(
    (m) => m.timestampMs >= region.startMs && m.timestampMs <= region.endMs,
  );

  if (regionMoves.length === 0) return [region];

  const results: ZoomRegion[] = [];
  let current: ZoomRegion = { ...region, id: crypto.randomUUID() };

  for (const move of regionMoves) {
    const z = current.zoomLevel;
    const halfW = 0.5 / z;
    const halfH = 0.5 / z;

    // Padded viewport bounds (trigger pan slightly before the actual edge)
    const left = current.focalX - halfW + VIEWPORT_PADDING;
    const right = current.focalX + halfW - VIEWPORT_PADDING;
    const top = current.focalY - halfH + VIEWPORT_PADDING;
    const bottom = current.focalY + halfH - VIEWPORT_PADDING;

    // Normalise mouse position to 0-1
    const mx = move.x / videoWidth;
    const my = move.y / videoHeight;

    const outOfFrame = mx < left || mx > right || my < top || my > bottom;

    if (outOfFrame) {
      // Ensure current sub-region has a minimum duration
      const elapsed = move.timestampMs - current.startMs;
      if (elapsed < MIN_REGION_DURATION_MS) continue;

      // Close current region at this timestamp
      current.endMs = move.timestampMs;
      results.push(current);

      // Open a new region centred on the mouse position (clamped to 0-1)
      current = {
        id: crypto.randomUUID(),
        startMs: move.timestampMs,
        endMs: region.endMs,
        zoomLevel: region.zoomLevel,
        focalX: Math.max(0, Math.min(1, mx)),
        focalY: Math.max(0, Math.min(1, my)),
        easeDurationMs: region.easeDurationMs,
      };
    }
  }

  // Push the final sub-region
  results.push(current);
  return results;
}
