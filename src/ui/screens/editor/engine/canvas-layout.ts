/**
 * Canvas layout math.
 *
 * This is the single source of truth for where the recording sits on the
 * canvas. Both the preview and the export pipeline render from it, so the main
 * process never needs to know: it only stores `canvasPadding` in the project
 * JSON alongside every other editing decision.
 */

import type { Project } from '@/types';

import type { CompositionLayout } from './types';

/** Padding is the fraction of the canvas kept clear on each side. */
export const MIN_CANVAS_PADDING = 0;
export const MAX_CANVAS_PADDING = 0.25;

/**
 * Matches the framing projects had when padding lived in the main process
 * (4 % padding on each side, then a 0.9 cap on how much of the rest the video
 * could fill): (1 - 0.92 * 0.9) / 2 ≈ 0.086.
 */
export const DEFAULT_CANVAS_PADDING = 0.086;

/** Slider granularity — 0.5 % of the canvas per step. */
export const CANVAS_PADDING_STEP = 0.005;

export type CanvasLayoutProject = Pick<Project, 'canvasBackgroundEnabled' | 'canvasPadding'>;

export function clampCanvasPadding(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CANVAS_PADDING;
  }

  return Math.min(MAX_CANVAS_PADDING, Math.max(MIN_CANVAS_PADDING, value));
}

/** The padding a project renders with, falling back to the default. */
export function resolveCanvasPadding(project: CanvasLayoutProject | null | undefined): number {
  return clampCanvasPadding(project?.canvasPadding);
}

/** Centre the recording inside the canvas, leaving `padding` clear on each side. */
export function calculateFramedLayout(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  padding: number = DEFAULT_CANVAS_PADDING,
): CompositionLayout {
  const paddingRatio = clampCanvasPadding(padding);
  const availableWidth = canvasWidth * (1 - paddingRatio * 2);
  const availableHeight = canvasHeight * (1 - paddingRatio * 2);

  const scaleX = availableWidth / Math.max(1, videoWidth);
  const scaleY = availableHeight / Math.max(1, videoHeight);
  const rawScale = Math.min(scaleX, scaleY);
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;

  const width = Math.max(1, Math.round(videoWidth * scale));
  const height = Math.max(1, Math.round(videoHeight * scale));
  const x = Math.round((canvasWidth - width) / 2);
  const y = Math.round((canvasHeight - height) / 2);

  return { x, y, width, height, scale };
}

/** Fill the canvas edge to edge — padding does not apply in this mode. */
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

/**
 * Resolve the layout for a project — full bleed when the canvas background is
 * off, otherwise framed with the project's padding.
 */
export function resolveProjectCanvasLayout(
  project: CanvasLayoutProject | null | undefined,
  source: { width: number; height: number },
  canvas: { width: number; height: number },
): CompositionLayout {
  if (project?.canvasBackgroundEnabled === false) {
    return calculateFullBleedLayout(source.width, source.height, canvas.width, canvas.height);
  }

  return calculateFramedLayout(
    source.width,
    source.height,
    canvas.width,
    canvas.height,
    resolveCanvasPadding(project),
  );
}
