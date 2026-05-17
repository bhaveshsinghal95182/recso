import type { Project } from '@/types';

import { clamp, DEFAULT_LAYOUT_CONFIG, DEFAULT_WEBCAM_STYLE } from '../export-pipeline/defaults';
import { resolveCroppedSourceDimensions } from '../source-crop';
import type { CompositionLayout } from '../types';
import type { CanvasSize } from './types';

export const DEFAULT_CANVAS_SIZE: CanvasSize = {
  width: 1920,
  height: 1080,
};

function toDefaultLayout(canvasSize: CanvasSize): CompositionLayout {
  return {
    x: 0,
    y: 0,
    width: canvasSize.width,
    height: canvasSize.height,
    scale: 1,
  };
}

export function calculateFullBleedLayout(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): CompositionLayout {
  const scaleX = canvasWidth / Math.max(1, videoWidth);
  const scaleY = canvasHeight / Math.max(1, videoHeight);
  const scale = Math.max(scaleX, scaleY);

  return {
    x: 0,
    y: 0,
    width: canvasWidth,
    height: canvasHeight,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
  };
}

export function calculateFallbackLayout(
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

export interface PreviewLayoutSnapshot {
  canvasSize: CanvasSize;
  layout: CompositionLayout;
  webcamLayout: CompositionLayout | null;
}

export async function loadPreviewLayoutSnapshot(
  project: Project,
  webcamSourcePath: string | undefined,
): Promise<PreviewLayoutSnapshot> {
  if (!project.videoDimensions) {
    return {
      canvasSize: DEFAULT_CANVAS_SIZE,
      layout: toDefaultLayout(DEFAULT_CANVAS_SIZE),
      webcamLayout: null,
    };
  }

  const effectiveVideoDimensions = resolveCroppedSourceDimensions(
    project.videoDimensions,
    project.cropConfig,
  );

  const canvasSize = await window.electron.compositor.getCanvasSize();
  const layout =
    project.canvasBackgroundEnabled === false
      ? calculateFullBleedLayout(
          effectiveVideoDimensions.width,
          effectiveVideoDimensions.height,
          canvasSize.width,
          canvasSize.height,
        )
      : await window.electron.compositor.calculateLayout(
          {
            width: effectiveVideoDimensions.width,
            height: effectiveVideoDimensions.height,
          },
          canvasSize,
        );

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
    layout,
    webcamLayout,
  };
}

export function buildFallbackPreviewLayoutSnapshot(
  project: Project,
  webcamSourcePath: string | undefined,
): PreviewLayoutSnapshot {
  if (!project.videoDimensions) {
    return {
      canvasSize: DEFAULT_CANVAS_SIZE,
      layout: toDefaultLayout(DEFAULT_CANVAS_SIZE),
      webcamLayout: null,
    };
  }

  const effectiveVideoDimensions = resolveCroppedSourceDimensions(
    project.videoDimensions,
    project.cropConfig,
  );

  const layout =
    project.canvasBackgroundEnabled === false
      ? calculateFullBleedLayout(
          effectiveVideoDimensions.width,
          effectiveVideoDimensions.height,
          DEFAULT_CANVAS_SIZE.width,
          DEFAULT_CANVAS_SIZE.height,
        )
      : calculateFallbackLayout(
          effectiveVideoDimensions.width,
          effectiveVideoDimensions.height,
          DEFAULT_CANVAS_SIZE.width,
          DEFAULT_CANVAS_SIZE.height,
        );

  const webcamLayout =
    project.webcamOverlay?.enabled && webcamSourcePath
      ? calculateFallbackWebcamLayout(
          DEFAULT_CANVAS_SIZE.width,
          DEFAULT_CANVAS_SIZE.height,
          project.webcamOverlay,
        )
      : null;

  return {
    canvasSize: DEFAULT_CANVAS_SIZE,
    layout,
    webcamLayout,
  };
}
