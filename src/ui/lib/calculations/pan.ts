import { MIN_REGION_DURATION_MS } from '@/constants';
import type { FocalKeyframe, RecordedMouseEvent, ZoomRegion } from '@/types';

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function resolveNormalizedEventCoordinates(
  event: RecordedMouseEvent,
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number } {
  const normalizedX = event.normalizedX;
  const normalizedY = event.normalizedY;

  if (typeof normalizedX === 'number' && typeof normalizedY === 'number') {
    return {
      x: clampUnit(normalizedX),
      y: clampUnit(normalizedY),
    };
  }

  return {
    x: clampUnit(event.x / Math.max(1, videoWidth)),
    y: clampUnit(event.y / Math.max(1, videoHeight)),
  };
}

/**
 * Analyse mouse **click** events within a zoom region and produce
 * focal-point keyframes so the camera jumps to each click position.
 *
 * The camera holds at each click location until the next click, then
 * eases to the new position (the easing is handled in ZoomEffect's
 * `resolveFocal`).
 *
 * Only click events are used — mouse-move events are ignored.
 */
export function smartPanSingleRegion(
  region: ZoomRegion,
  events: RecordedMouseEvent[],
  videoWidth: number,
  videoHeight: number,
): ZoomRegion {
  // Filter to clicks that fall within this region's time span
  const clicks = events.filter(
    (e) =>
      e.eventType === 'click' && e.timestampMs >= region.startMs && e.timestampMs <= region.endMs,
  );

  if (clicks.length === 0) {
    return { ...region, focalKeyframes: undefined };
  }

  const keyframes: FocalKeyframe[] = [];
  let lastKeyframeMs = region.startMs;

  for (const click of clicks) {
    // Enforce minimum time between keyframes
    const elapsed = click.timestampMs - lastKeyframeMs;
    if (elapsed < MIN_REGION_DURATION_MS) continue;

    const { x: focalX, y: focalY } = resolveNormalizedEventCoordinates(
      click,
      videoWidth,
      videoHeight,
    );

    keyframes.push({
      timestampMs: click.timestampMs,
      focalX,
      focalY,
    });

    lastKeyframeMs = click.timestampMs;
  }

  return {
    ...region,
    focalKeyframes: keyframes.length > 0 ? keyframes : undefined,
  };
}
