/**
 * How a webcam zoom region decides the webcam's size while it runs.
 *
 * Split out of the panel because none of it is UI: it is the arithmetic the
 * controls are a view of, and it has to agree with
 * `computeActiveWebcamHeightRatio` in the engine or the slider promises a size
 * the preview will not draw. Keeping it here means it can be checked directly
 * rather than through a React tree.
 */

import type { ZoomRegion } from '@/types';

export const MIN_HEIGHT_RATIO = 0.08;
export const MAX_HEIGHT_RATIO = 0.75;
/** Upper bound of the Grow slider before the size ceiling is taken into account. */
export const GROW_ZOOM_CEILING = 5;
/** The Grow slider's step, which is also the smallest change it can express. */
export const GROW_ZOOM_STEP = 0.1;

/** The three exclusive ways a region can state its size. */
export type RegionSizeMode = 'grow' | 'exact' | 'fill';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Which of the three exclusive sizing modes a region is currently in. */
export function resolveRegionSizeMode(region: ZoomRegion | undefined): RegionSizeMode {
  if (!region) {
    return 'grow';
  }

  if (region.webcamFullScreen === true) {
    return 'fill';
  }

  return Number.isFinite(region.webcamHeightRatio) ? 'exact' : 'grow';
}

/** The size a region resolves to, mirroring computeActiveWebcamHeightRatio. */
export function resolveRegionHeightRatio(
  region: ZoomRegion | undefined,
  baseHeightRatio: number,
): number {
  if (!region) {
    return clamp(baseHeightRatio, MIN_HEIGHT_RATIO, MAX_HEIGHT_RATIO);
  }

  if (Number.isFinite(region.webcamHeightRatio)) {
    return clamp(region.webcamHeightRatio as number, MIN_HEIGHT_RATIO, MAX_HEIGHT_RATIO);
  }

  return clamp(
    baseHeightRatio * Math.max(0.1, region.zoomLevel),
    MIN_HEIGHT_RATIO,
    MAX_HEIGHT_RATIO,
  );
}

/**
 * Grow multiplies the base size, so it stops doing anything the moment
 * `base * zoom` hits the MAX_HEIGHT_RATIO ceiling. Past that point the slider is
 * dead travel: the numbers move, the webcam does not. This returns the largest
 * zoom worth offering, snapped down to the slider's step so the top of the track
 * still lands under the ceiling instead of on top of it.
 */
export function resolveGrowMaxZoom(baseHeightRatio: number): number {
  const saturation = MAX_HEIGHT_RATIO / Math.max(baseHeightRatio, 0.0001);
  const step = 1 / GROW_ZOOM_STEP;

  return clamp(Math.floor(saturation * step) / step, 1, GROW_ZOOM_CEILING);
}

/**
 * Whether Grow can still do anything at this base size.
 *
 * True once the slider has less than one step of usable travel -- which covers
 * a base sitting exactly on the ceiling and a base close enough that the only
 * growth left is smaller than the control can express.
 */
export function isGrowSaturated(baseHeightRatio: number): boolean {
  return resolveGrowMaxZoom(baseHeightRatio) <= 1;
}
