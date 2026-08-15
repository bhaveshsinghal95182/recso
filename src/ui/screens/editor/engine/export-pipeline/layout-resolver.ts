import type { Project } from '@/types';

import type { CanvasLayoutProject } from '../canvas-layout';
import { resolveProjectCanvasLayout } from '../canvas-layout';
import type { CompositionLayout } from '../types';
import { resolveAnchoredPosition } from '../webcam-anchor';
import { clamp, DEFAULT_WEBCAM_STYLE } from './defaults';

function calculateFallbackWebcamLayout(
  canvasWidth: number,
  canvasHeight: number,
  webcamOverlay: Project['webcamOverlay'],
): CompositionLayout {
  const aspectRatio =
    Number.isFinite(webcamOverlay?.aspectRatio) && (webcamOverlay?.aspectRatio as number) > 0
      ? (webcamOverlay?.aspectRatio as number)
      : DEFAULT_WEBCAM_STYLE.aspectRatio;
  const heightRatio = clamp(
    Number.isFinite(webcamOverlay?.heightRatio)
      ? (webcamOverlay?.heightRatio as number)
      : DEFAULT_WEBCAM_STYLE.heightRatio,
    0.08,
    0.75,
  );
  const marginPx = clamp(
    Math.round(
      Number.isFinite(webcamOverlay?.marginPx)
        ? (webcamOverlay?.marginPx as number)
        : DEFAULT_WEBCAM_STYLE.marginPx,
    ),
    0,
    Math.floor(Math.min(canvasWidth, canvasHeight) / 2),
  );

  let height = Math.max(1, Math.round(canvasHeight * heightRatio));
  let width = Math.max(1, Math.round(height * aspectRatio));

  const maxWidth = Math.max(1, canvasWidth - marginPx * 2);
  const maxHeight = Math.max(1, canvasHeight - marginPx * 2);

  if (width > maxWidth) {
    width = maxWidth;
    height = Math.max(1, Math.round(width / aspectRatio));
  }

  if (height > maxHeight) {
    height = maxHeight;
    width = Math.max(1, Math.round(height * aspectRatio));
  }

  const position = resolveAnchoredPosition(
    webcamOverlay?.anchor ?? DEFAULT_WEBCAM_STYLE.anchor,
    width,
    height,
    canvasWidth,
    canvasHeight,
    marginPx,
  );

  return {
    x: position.x,
    y: position.y,
    width,
    height,
    scale: height / Math.max(1, canvasHeight),
  };
}

/**
 * The export uses the same layout math as the preview, driven by the project's
 * own padding, so what you see in the editor is what gets rendered.
 */
export function resolveLayout(
  project: CanvasLayoutProject,
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): CompositionLayout {
  return resolveProjectCanvasLayout(
    project,
    { width: videoWidth, height: videoHeight },
    { width: canvasWidth, height: canvasHeight },
  );
}

export async function resolveWebcamLayout(
  canvasWidth: number,
  canvasHeight: number,
  webcamOverlay: Project['webcamOverlay'],
): Promise<CompositionLayout> {
  try {
    return await window.electron.compositor.calculateWebcamLayout(
      {
        width: canvasWidth,
        height: canvasHeight,
      },
      {
        anchor: webcamOverlay?.anchor ?? DEFAULT_WEBCAM_STYLE.anchor,
        aspectRatio:
          Number.isFinite(webcamOverlay?.aspectRatio) && (webcamOverlay?.aspectRatio as number) > 0
            ? (webcamOverlay?.aspectRatio as number)
            : DEFAULT_WEBCAM_STYLE.aspectRatio,
        heightRatio:
          Number.isFinite(webcamOverlay?.heightRatio) && (webcamOverlay?.heightRatio as number) > 0
            ? (webcamOverlay?.heightRatio as number)
            : DEFAULT_WEBCAM_STYLE.heightRatio,
        marginPx: Number.isFinite(webcamOverlay?.marginPx)
          ? Math.max(0, webcamOverlay?.marginPx as number)
          : DEFAULT_WEBCAM_STYLE.marginPx,
      },
    );
  } catch {
    return calculateFallbackWebcamLayout(canvasWidth, canvasHeight, webcamOverlay);
  }
}
