import type { Project } from '@/types';

import { clamp, DEFAULT_WEBCAM_STYLE } from '../export-pipeline/defaults';
import type { CompositionLayout } from '../types';
import { resolveAnchoredPosition } from '../webcam-anchor';
import type { CanvasSize } from './types';

export const DEFAULT_CANVAS_SIZE: CanvasSize = {
  width: 1920,
  height: 1080,
};

export function calculateFallbackWebcamLayout(
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
 * What the preview still asks the main process for. The video layout is not in
 * here — the renderer derives that from the project's own padding.
 */
export interface PreviewLayoutSnapshot {
  canvasSize: CanvasSize;
  webcamLayout: CompositionLayout | null;
}

export async function loadPreviewLayoutSnapshot(
  project: Project,
  webcamSourcePath: string | undefined,
): Promise<PreviewLayoutSnapshot> {
  if (!project.videoDimensions) {
    return {
      canvasSize: DEFAULT_CANVAS_SIZE,
      webcamLayout: null,
    };
  }

  const canvasSize = await window.electron.compositor.getCanvasSize();

  let webcamLayout: CompositionLayout | null = null;
  if (project.webcamOverlay?.enabled && webcamSourcePath) {
    webcamLayout = await window.electron.compositor.calculateWebcamLayout(canvasSize, {
      anchor: project.webcamOverlay.anchor ?? DEFAULT_WEBCAM_STYLE.anchor,
      aspectRatio:
        Number.isFinite(project.webcamOverlay.aspectRatio) &&
        (project.webcamOverlay.aspectRatio as number) > 0
          ? (project.webcamOverlay.aspectRatio as number)
          : DEFAULT_WEBCAM_STYLE.aspectRatio,
      heightRatio:
        Number.isFinite(project.webcamOverlay.heightRatio) &&
        (project.webcamOverlay.heightRatio as number) > 0
          ? (project.webcamOverlay.heightRatio as number)
          : DEFAULT_WEBCAM_STYLE.heightRatio,
      marginPx: Number.isFinite(project.webcamOverlay.marginPx)
        ? Math.max(0, project.webcamOverlay.marginPx as number)
        : DEFAULT_WEBCAM_STYLE.marginPx,
    });
  }

  return {
    canvasSize,
    webcamLayout,
  };
}

export function buildFallbackPreviewLayoutSnapshot(
  project: Project,
  webcamSourcePath: string | undefined,
): PreviewLayoutSnapshot {
  const webcamLayout =
    project.videoDimensions && project.webcamOverlay?.enabled && webcamSourcePath
      ? calculateFallbackWebcamLayout(
          DEFAULT_CANVAS_SIZE.width,
          DEFAULT_CANVAS_SIZE.height,
          project.webcamOverlay,
        )
      : null;

  return {
    canvasSize: DEFAULT_CANVAS_SIZE,
    webcamLayout,
  };
}
