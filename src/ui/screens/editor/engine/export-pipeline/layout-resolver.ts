import type { Project } from '@/types';

import type { CompositionLayout } from '../types';
import { clamp, DEFAULT_LAYOUT_CONFIG, DEFAULT_WEBCAM_STYLE } from './defaults';

function calculateFallbackLayout(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): CompositionLayout {
  const availableWidth =
    canvasWidth * (1 - DEFAULT_LAYOUT_CONFIG.padding * 2) * DEFAULT_LAYOUT_CONFIG.maxScale;
  const availableHeight =
    canvasHeight * (1 - DEFAULT_LAYOUT_CONFIG.padding * 2) * DEFAULT_LAYOUT_CONFIG.maxScale;

  const scaleX = availableWidth / videoWidth;
  const scaleY = availableHeight / videoHeight;

  let scale = Math.min(scaleX, scaleY);
  if (!DEFAULT_LAYOUT_CONFIG.scaleUp && scale > 1) {
    scale = 1;
  }

  const width = Math.round(videoWidth * scale);
  const height = Math.round(videoHeight * scale);
  const x = Math.round((canvasWidth - width) / 2);
  const y = Math.round((canvasHeight - height) / 2);

  return { x, y, width, height, scale };
}

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

  const anchor = webcamOverlay?.anchor ?? DEFAULT_WEBCAM_STYLE.anchor;
  let x = marginPx;
  let y = marginPx;
  switch (anchor) {
    case 'top-right':
      x = canvasWidth - width - marginPx;
      y = marginPx;
      break;
    case 'bottom-left':
      x = marginPx;
      y = canvasHeight - height - marginPx;
      break;
    case 'bottom-right':
      x = canvasWidth - width - marginPx;
      y = canvasHeight - height - marginPx;
      break;
    case 'top-left':
    default:
      x = marginPx;
      y = marginPx;
      break;
  }

  return {
    x: clamp(Math.round(x), 0, Math.max(0, canvasWidth - width)),
    y: clamp(Math.round(y), 0, Math.max(0, canvasHeight - height)),
    width,
    height,
    scale: height / Math.max(1, canvasHeight),
  };
}

export async function resolveLayout(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): Promise<CompositionLayout> {
  try {
    return await window.electron.compositor.calculateLayout(
      {
        width: videoWidth,
        height: videoHeight,
      },
      {
        width: canvasWidth,
        height: canvasHeight,
      },
    );
  } catch {
    return calculateFallbackLayout(videoWidth, videoHeight, canvasWidth, canvasHeight);
  }
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
