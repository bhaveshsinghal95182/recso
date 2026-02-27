import { MIN_REGION_DURATION_MS } from '@/constants';
import type { FocalKeyframe, RecordedMouseEvent, ZoomRegion } from '@/types';

/**
 * Analyse mouse **click** events within a zoom region and produce
 * focal-point keyframes so the camera jumps to each click position.
 *
 * The camera holds at each click location until the next click, then
 * eases to the new position (the easing is handled in ZoomEffect's
 * `resolveFocal`).
 *
 * Only click events are used — mouse-move events are ignored.
 *
 * NOTE: Mouse events store NORMALISED 0-1 ratios (not raw pixels).
 * The coordinates are already relative to the capture source, so we
 * just clamp to 0-1 directly without dividing by video dimensions.
 */
export function smartPanSingleRegion(
  region: ZoomRegion,
  events: RecordedMouseEvent[],
  _videoWidth: number,
  _videoHeight: number,
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

    // Coordinates are already 0-1 normalised ratios — just clamp
    const focalX = Math.max(0, Math.min(1, click.x));
    const focalY = Math.max(0, Math.min(1, click.y));

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
