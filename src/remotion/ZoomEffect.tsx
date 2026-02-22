import React, { useMemo } from 'react';
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

import { compositionToSourceTime, getUncutSegments } from './cut-utils';
import type { CompositionFocalKeyframe, RemotionInputProps } from './types';

/**
 * Duration (ms) of the eased transition between focal-point keyframes.
 * The camera holds at each click position and eases to the next over this window.
 */
const PAN_EASE_MS = 300;

/**
 * Resolve the focal point at a given timestamp.
 *
 * Behaviour when focalKeyframes are present:
 * - Hold at the region's initial focalX/focalY until the first keyframe
 * - At each keyframe, ease to the new focal position over PAN_EASE_MS
 * - Hold that position until the next keyframe
 * - After the last keyframe, hold the last position
 *
 * Without keyframes, the static focalX/focalY is returned.
 */
function resolveFocal(
  focalX: number,
  focalY: number,
  keyframes: CompositionFocalKeyframe[] | undefined,
  currentTimeMs: number,
  _regionStartMs: number,
): { fx: number; fy: number } {
  if (!keyframes || keyframes.length === 0) {
    return { fx: focalX, fy: focalY };
  }

  // Before the first keyframe begins its transition → hold initial focal
  const firstTransitionStart = keyframes[0].timestampMs - PAN_EASE_MS;
  if (currentTimeMs < firstTransitionStart) {
    return { fx: focalX, fy: focalY };
  }

  // Check if we're in the transition window leading INTO the first keyframe
  if (currentTimeMs < keyframes[0].timestampMs) {
    const t = (currentTimeMs - firstTransitionStart) / PAN_EASE_MS;
    const eased = easeInOut(t);
    return {
      fx: focalX + (keyframes[0].focalX - focalX) * eased,
      fy: focalY + (keyframes[0].focalY - focalY) * eased,
    };
  }

  // Walk through keyframes to find where we are
  for (let i = 0; i < keyframes.length; i++) {
    const current = keyframes[i];
    const next = keyframes[i + 1];

    // If there's no next keyframe, hold at current
    if (!next) {
      return { fx: current.focalX, fy: current.focalY };
    }

    // The transition to the next keyframe starts PAN_EASE_MS before it
    const transitionStart = next.timestampMs - PAN_EASE_MS;

    // We're in the hold phase of the current keyframe
    if (currentTimeMs < transitionStart) {
      return { fx: current.focalX, fy: current.focalY };
    }

    // We're in the transition window to the next keyframe
    if (currentTimeMs < next.timestampMs) {
      const t = (currentTimeMs - transitionStart) / PAN_EASE_MS;
      const eased = easeInOut(t);
      return {
        fx: current.focalX + (next.focalX - current.focalX) * eased,
        fy: current.focalY + (next.focalY - current.focalY) * eased,
      };
    }
  }

  // Fallback: hold last keyframe
  const last = keyframes[keyframes.length - 1];
  return { fx: last.focalX, fy: last.focalY };
}

/** Simple ease-in-out (smoothstep) for 0-1 range */
function easeInOut(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * ZoomEffect: Applies zoom animations based on zoomRegions.
 *
 * Replaces the FFmpeg zoom-filter with smooth, eased CSS transforms.
 * Uses easeDurationMs from each region for timing and normalized
 * focal points (0-1) for transform-origin.
 *
 * When a region has focalKeyframes (produced by smart pan),
 * the focal point is smoothly interpolated between keyframes
 * rather than staying static.
 */
export const ZoomEffect: React.FC<{ children: React.ReactNode } & RemotionInputProps> = ({
  children,
  zoomRegions,
  layout,
  cuts,
  sourceDurationMs,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Pre-compute uncut segments for time-mapping
  const segments = useMemo(
    () => getUncutSegments(cuts, sourceDurationMs || 0),
    [cuts, sourceDurationMs],
  );

  // Composition time (shortened timeline, post-cuts)
  const compositionTimeMs = (frame / fps) * 1000;

  // Map back to source video time so zoom regions (defined on source timeline) work correctly
  const hasCuts = cuts && cuts.length > 0 && sourceDurationMs;
  const currentTimeMs = hasCuts
    ? compositionToSourceTime(compositionTimeMs, segments)
    : compositionTimeMs;

  // Use exclusive end (< endMs) so that consecutive regions with
  // abutting boundaries never both match on the same frame.
  const activeZoom = zoomRegions?.find(
    (region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
  );

  let zoomLevel = 1;
  let originX = layout ? layout.x + layout.width / 2 : 0;
  let originY = layout ? layout.y + layout.height / 2 : 0;

  if (activeZoom) {
    const regionDurationMs = activeZoom.endMs - activeZoom.startMs;

    if (regionDurationMs > 0) {
      const progress = (currentTimeMs - activeZoom.startMs) / regionDurationMs;

      // Clamp the effective ease duration so that the ease-in and ease-out phases
      // never overlap.
      const clampedEaseMs = Math.min(activeZoom.easeDurationMs, regionDurationMs / 2 - 1);
      const safeDurationMs = Math.max(clampedEaseMs, 0);

      if (safeDurationMs <= 0) {
        // Region is too short for any easing — hold constant zoom
        zoomLevel = activeZoom.zoomLevel;
      } else {
        const easeInEnd = safeDurationMs / regionDurationMs;
        const easeOutStart = 1 - safeDurationMs / regionDurationMs;

        zoomLevel = interpolate(
          progress,
          [0, easeInEnd, easeOutStart, 1],
          [1, activeZoom.zoomLevel, activeZoom.zoomLevel, 1],
          {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.25, 0.1, 0.25, 1),
          },
        );
      }

      // Resolve focal point — either static or interpolated from keyframes
      const { fx, fy } = resolveFocal(
        activeZoom.focalX,
        activeZoom.focalY,
        activeZoom.focalKeyframes,
        currentTimeMs,
        activeZoom.startMs,
      );

      // Focal points are normalized (0-1) relative to the VIDEO area.
      // Transform-origin must include the video's offset on the canvas.
      originX = layout.x + fx * layout.width;
      originY = layout.y + fy * layout.height;
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        transform: `scale(${zoomLevel})`,
        transformOrigin: `${originX}px ${originY}px`,
        willChange: 'transform',
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
};
