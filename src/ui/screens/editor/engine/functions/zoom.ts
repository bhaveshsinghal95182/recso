import type { CompositionConfig, CompositionZoomRegion, ZoomKeyframe, ZoomState } from '../types';
import { clamp, clampNormalised, lerp, smoothstep } from './common';

function resolveRegionFocalPoint(
  region: CompositionZoomRegion,
  timestampMs: number,
): { x: number; y: number } {
  const keyframes = region.focalKeyframes ?? [];
  if (keyframes.length === 0) {
    return {
      x: clampNormalised(region.focalX),
      y: clampNormalised(region.focalY),
    };
  }

  const points = [
    {
      timestampMs: region.startMs,
      focalX: clampNormalised(region.focalX),
      focalY: clampNormalised(region.focalY),
    },
    ...keyframes
      .map((point) => ({
        timestampMs: point.timestampMs,
        focalX: clampNormalised(point.focalX),
        focalY: clampNormalised(point.focalY),
      }))
      .sort((a, b) => a.timestampMs - b.timestampMs),
  ];

  if (timestampMs <= points[0].timestampMs) {
    return { x: points[0].focalX, y: points[0].focalY };
  }

  const lastPoint = points[points.length - 1];
  if (timestampMs >= lastPoint.timestampMs) {
    return { x: lastPoint.focalX, y: lastPoint.focalY };
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];

    if (timestampMs >= current.timestampMs && timestampMs <= next.timestampMs) {
      const range = next.timestampMs - current.timestampMs;
      if (range <= 0) {
        return { x: current.focalX, y: current.focalY };
      }

      const mix = (timestampMs - current.timestampMs) / range;
      return {
        x: lerp(current.focalX, next.focalX, mix),
        y: lerp(current.focalY, next.focalY, mix),
      };
    }
  }

  return { x: lastPoint.focalX, y: lastPoint.focalY };
}

export function computeZoomStateFromRegions(
  timestampMs: number,
  zoomRegions: CompositionZoomRegion[],
  frameWidth: number,
  frameHeight: number,
): ZoomState {
  let scale = 1;
  let pivotX = frameWidth / 2;
  let pivotY = frameHeight / 2;

  for (const region of zoomRegions) {
    if (timestampMs >= region.startMs && timestampMs <= region.endMs) {
      const easeDurationMs = Math.max(0, region.easeDurationMs);
      let eased = 1;

      if (easeDurationMs > 0 && timestampMs < region.startMs + easeDurationMs) {
        eased = smoothstep((timestampMs - region.startMs) / easeDurationMs);
      } else if (easeDurationMs > 0 && timestampMs > region.endMs - easeDurationMs) {
        eased = smoothstep((region.endMs - timestampMs) / easeDurationMs);
      }

      scale = 1 + (region.zoomLevel - 1) * eased;
      const focal = resolveRegionFocalPoint(region, timestampMs);
      pivotX = focal.x * frameWidth;
      pivotY = focal.y * frameHeight;
      break;
    }
  }

  return { scale, pivotX, pivotY };
}

export function computeZoomState(
  t: number,
  zooms: ZoomKeyframe[],
  frameWidth: number,
  frameHeight: number,
): ZoomState {
  let scale = 1;
  let pivotX = frameWidth / 2;
  let pivotY = frameHeight / 2;

  for (const zoom of zooms) {
    if (t >= zoom.startTime && t <= zoom.endTime) {
      const easeIn = zoom.easeIn ?? 0.3;
      const easeOut = zoom.easeOut ?? 0.3;
      let eased = 1;

      if (t < zoom.startTime + easeIn && easeIn > 0) {
        eased = smoothstep((t - zoom.startTime) / easeIn);
      } else if (t > zoom.endTime - easeOut && easeOut > 0) {
        eased = smoothstep((zoom.endTime - t) / easeOut);
      }

      scale = 1 + (zoom.multiplier - 1) * eased;
      pivotX = zoom.focalPoint.x * frameWidth;
      pivotY = zoom.focalPoint.y * frameHeight;
      break;
    }
  }

  return { scale, pivotX, pivotY };
}

export function computeZoomStateFromConfig(
  t: number,
  config: CompositionConfig,
  frameWidth: number,
  frameHeight: number,
): ZoomState {
  if (config.zoomRegions && config.zoomRegions.length > 0) {
    return computeZoomStateFromRegions(t * 1000, config.zoomRegions, frameWidth, frameHeight);
  }

  return computeZoomState(t, config.zooms, frameWidth, frameHeight);
}

/**
 * Resolve the active webcam heightRatio at a given timestamp by inspecting
 * webcam-source zoom regions.
 *
 * Priority per active region:
 * 1) explicit `webcamHeightRatio` override (if present)
 * 2) derived ratio from `baseHeightRatio * zoomLevel`
 *
 * Returns `undefined` when no region applies.
 */
export function computeActiveWebcamHeightRatio(
  timestampMs: number,
  zoomRegions: CompositionZoomRegion[],
  baseHeightRatio: number,
): number | undefined {
  for (const region of zoomRegions) {
    if (timestampMs >= region.startMs && timestampMs <= region.endMs) {
      const explicitTarget = Number.isFinite(region.webcamHeightRatio)
        ? (region.webcamHeightRatio as number)
        : undefined;
      const zoomLevel = Number.isFinite(region.zoomLevel) ? region.zoomLevel : 1;
      const derivedTarget = baseHeightRatio * Math.max(0.1, zoomLevel);
      const targetHeightRatio = clamp(explicitTarget ?? derivedTarget, 0.08, 0.75);
      const easeDurationMs = Math.max(0, region.easeDurationMs);
      let eased = 1;

      if (easeDurationMs > 0 && timestampMs < region.startMs + easeDurationMs) {
        eased = smoothstep((timestampMs - region.startMs) / easeDurationMs);
      } else if (easeDurationMs > 0 && timestampMs > region.endMs - easeDurationMs) {
        eased = smoothstep((region.endMs - timestampMs) / easeDurationMs);
      }

      return lerp(baseHeightRatio, targetHeightRatio, eased);
    }
  }

  return undefined;
}

/**
 * Resolve the active webcam full-canvas transition progress at a timestamp.
 *
 * Returns a value in [0, 1] where:
 * - 0 = normal webcam overlay layout
 * - 1 = webcam fully expanded to canvas
 */
export function computeActiveWebcamFullScreenProgress(
  timestampMs: number,
  zoomRegions: CompositionZoomRegion[],
): number {
  for (const region of zoomRegions) {
    if (
      timestampMs >= region.startMs &&
      timestampMs <= region.endMs &&
      region.webcamFullScreen === true
    ) {
      const easeDurationMs = Math.max(0, region.easeDurationMs);
      if (easeDurationMs <= 0) {
        return 1;
      }

      let eased = 1;
      if (timestampMs < region.startMs + easeDurationMs) {
        eased = smoothstep((timestampMs - region.startMs) / easeDurationMs);
      } else if (timestampMs > region.endMs - easeDurationMs) {
        eased = smoothstep((region.endMs - timestampMs) / easeDurationMs);
      }

      return clamp(eased, 0, 1);
    }
  }

  return 0;
}

/**
 * Resolve whether webcam full-canvas mode is active at a given timestamp.
 *
 * Returns true when an active webcam-source region has `webcamFullScreen` enabled.
 */
export function computeActiveWebcamFullScreen(
  timestampMs: number,
  zoomRegions: CompositionZoomRegion[],
): boolean {
  return computeActiveWebcamFullScreenProgress(timestampMs, zoomRegions) > 0;
}
