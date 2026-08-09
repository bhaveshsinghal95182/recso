/**
 * Webcam anchor placement.
 *
 * The anchor is a 3x3 grid. Each axis resolves to a fraction — 0 pins the
 * leading edge, 1 pins the trailing edge, 0.5 centres the box — so a single
 * formula covers all nine positions:
 *
 *   position = margin + (canvasSize - boxSize - margin * 2) * fraction
 *
 * At 0 that is `margin`, at 1 it is `canvasSize - boxSize - margin`, and at 0.5
 * the margins cancel to leave the box exactly centred. Keep this the only place
 * the placement is derived — the renderer, the export pipeline and the preview
 * fallback all read from here, and they must agree pixel for pixel or the
 * preview drifts from the exported frame.
 */

import type { WebcamOverlayAnchor } from '@/types';

export interface AnchorFractions {
  /** 0 = left edge, 0.5 = horizontally centred, 1 = right edge. */
  x: number;
  /** 0 = top edge, 0.5 = vertically centred, 1 = bottom edge. */
  y: number;
}

const ANCHOR_FRACTIONS: Record<WebcamOverlayAnchor, AnchorFractions> = {
  'top-left': { x: 0, y: 0 },
  'top-center': { x: 0.5, y: 0 },
  'top-right': { x: 1, y: 0 },
  'center-left': { x: 0, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  'center-right': { x: 1, y: 0.5 },
  'bottom-left': { x: 0, y: 1 },
  'bottom-center': { x: 0.5, y: 1 },
  'bottom-right': { x: 1, y: 1 },
};

/** Row-major order, so a picker can map this straight onto a 3x3 grid. */
export const WEBCAM_ANCHORS: readonly WebcamOverlayAnchor[] = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

const ANCHOR_LABELS: Record<WebcamOverlayAnchor, string> = {
  'top-left': 'Top left',
  'top-center': 'Top centre',
  'top-right': 'Top right',
  'center-left': 'Middle left',
  center: 'Centre',
  'center-right': 'Middle right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom centre',
  'bottom-right': 'Bottom right',
};

export function getAnchorLabel(anchor: WebcamOverlayAnchor): string {
  return ANCHOR_LABELS[anchor];
}

export function resolveAnchorFractions(anchor: WebcamOverlayAnchor | undefined): AnchorFractions {
  return (anchor && ANCHOR_FRACTIONS[anchor]) ?? ANCHOR_FRACTIONS['bottom-right'];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Top-left corner of the webcam box for the given anchor, in canvas pixels. */
export function resolveAnchoredPosition(
  anchor: WebcamOverlayAnchor | undefined,
  boxWidth: number,
  boxHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  marginPx: number,
): { x: number; y: number } {
  const fractions = resolveAnchorFractions(anchor);

  const x = marginPx + (canvasWidth - boxWidth - marginPx * 2) * fractions.x;
  const y = marginPx + (canvasHeight - boxHeight - marginPx * 2) * fractions.y;

  return {
    x: clamp(Math.round(x), 0, Math.max(0, canvasWidth - boxWidth)),
    y: clamp(Math.round(y), 0, Math.max(0, canvasHeight - boxHeight)),
  };
}
