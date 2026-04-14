/**
 * CompositorService — The "Math Brain" for video compositing.
 *
 * Responsibilities:
 * - Manages compositor configuration (background, layout settings)
 * - Calculates layout positioning for centering/scaling video on canvas
 * - Provides a single source of truth for both frontend preview and backend export
 *
 * Note: This service does NOT render pixels. Rendering is done by:
 * - Frontend: Canvas in the Editor (Phase 13)
 * - Backend: FFmpeg during export (Phase 11)
 */

import fs from 'fs';
import path from 'path';

import type {
  CompositorConfig,
  LayoutConfig,
  LayoutResult,
  Rectangle,
  Size,
  WebcamLayoutRequest,
  WebcamLayoutResult,
} from '../types/compositor.types.js';
import { DEFAULT_COMPOSITOR_CONFIG } from '../types/compositor.types.js';

const DEFAULT_WEBCAM_ASPECT_RATIO = 9 / 16;
const DEFAULT_WEBCAM_HEIGHT_RATIO = 0.28;
const DEFAULT_WEBCAM_MARGIN_PX = 24;
const MIN_WEBCAM_HEIGHT_RATIO = 0.08;
const MAX_WEBCAM_HEIGHT_RATIO = 0.75;
const MAX_WEBCAM_CANVAS_WIDTH_RATIO = 0.5;
const MAX_WEBCAM_CANVAS_HEIGHT_RATIO = 0.9;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Current compositor configuration
let config: CompositorConfig = { ...DEFAULT_COMPOSITOR_CONFIG };

/**
 * Get the current compositor configuration
 */
export function getConfig(): CompositorConfig {
  return { ...config };
}

/**
 * Update compositor configuration (partial update)
 */
export function updateConfig(updates: Partial<CompositorConfig>): CompositorConfig {
  config = { ...config, ...updates };
  return getConfig();
}

/**
 * Set the background image path
 * @param imagePath - Absolute path to image file, or null to clear
 * @returns true if valid, false if file doesn't exist
 */
export function setBackground(imagePath: string | null): boolean {
  if (imagePath === null) {
    config.backgroundPath = null;
    return true;
  }

  // Validate file exists
  if (!fs.existsSync(imagePath)) {
    console.warn('[CompositorService] Background image not found:', imagePath);
    return false;
  }

  // Validate it's an image file
  const ext = path.extname(imagePath).toLowerCase();
  const validExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];
  if (!validExtensions.includes(ext)) {
    console.warn('[CompositorService] Invalid image extension:', ext);
    return false;
  }

  config.backgroundPath = imagePath;
  console.log('[CompositorService] Background set to:', imagePath);
  return true;
}

/**
 * Get the current background path
 */
export function getBackground(): string | null {
  return config.backgroundPath;
}

/**
 * Set the background color (used when no image is set)
 * @param color - Hex color string (e.g., '#1a1a2e')
 */
export function setBackgroundColor(color: string): void {
  config.backgroundColor = color;
}

/**
 * Get the current background color
 */
export function getBackgroundColor(): string {
  return config.backgroundColor;
}

/**
 * Set the target canvas size
 */
export function setCanvasSize(size: Size): void {
  config.canvasSize = { ...size };
}

/**
 * Get the target canvas size
 */
export function getCanvasSize(): Size {
  return { ...config.canvasSize };
}

/**
 * Update layout configuration
 */
export function setLayoutConfig(layoutConfig: Partial<LayoutConfig>): void {
  config.layout = { ...config.layout, ...layoutConfig };
}

/**
 * Get layout configuration
 */
export function getLayoutConfig(): LayoutConfig {
  return { ...config.layout };
}

/**
 * Calculate the layout for placing a video on the canvas.
 *
 * Logic:
 * 1. Calculate the scale needed to fit the video within available space (with padding)
 * 2. If scaleUp is enabled, scale up small videos to fill more of the canvas
 * 3. Apply maxScale as a limit on how much of the available space to fill
 * 4. Center the result on the canvas
 *
 * @param videoBounds - The original video/window dimensions
 * @param canvasSize - Optional override for canvas size (defaults to config)
 * @returns LayoutResult with position, size, and scale factor
 */
export function calculateLayout(videoBounds: Rectangle | Size, canvasSize?: Size): LayoutResult {
  const canvas = canvasSize || config.canvasSize;
  const layout = config.layout;

  // Extract video dimensions
  const videoWidth = videoBounds.width;
  const videoHeight = videoBounds.height;

  console.log('[Compositor] Calculating layout:', {
    video: `${videoWidth}x${videoHeight}`,
    canvas: `${canvas.width}x${canvas.height}`,
    padding: layout.padding,
    maxScale: layout.maxScale,
    scaleUp: layout.scaleUp,
  });

  // Calculate available space (with padding)
  // maxScale further limits how much of the available space we use
  const effectiveMaxFill = layout.maxScale; // e.g., 0.9 means fill up to 90% of available space
  const availableWidth = canvas.width * (1 - layout.padding * 2) * effectiveMaxFill;
  const availableHeight = canvas.height * (1 - layout.padding * 2) * effectiveMaxFill;

  // Calculate scale factors to fit video within the available space
  const scaleX = availableWidth / videoWidth;
  const scaleY = availableHeight / videoHeight;

  // Use the smaller scale to maintain aspect ratio (ensures video fits)
  let scale = Math.min(scaleX, scaleY);

  // If scaleUp is false and this would scale up the video, use 1:1 instead
  if (!layout.scaleUp && scale > 1) {
    scale = 1;
  }

  // Calculate final dimensions
  const finalWidth = Math.round(videoWidth * scale);
  const finalHeight = Math.round(videoHeight * scale);

  // Center on canvas
  const x = Math.round((canvas.width - finalWidth) / 2);
  const y = Math.round((canvas.height - finalHeight) / 2);

  const result = {
    x,
    y,
    width: finalWidth,
    height: finalHeight,
    scale,
  };

  console.log('[Compositor] Final layout:', result, {
    scaleX: scaleX.toFixed(3),
    scaleY: scaleY.toFixed(3),
    chosenScale: scale.toFixed(3),
  });

  return result;
}

/**
 * Calculate a webcam overlay layout on the canvas.
 *
 * Defaults:
 * - bottom-right anchor
 * - 9:16 vertical aspect ratio
 * - 28% of canvas height
 * - 24px margin
 */
export function calculateWebcamLayout(
  canvasSize?: Size,
  request?: WebcamLayoutRequest,
): WebcamLayoutResult {
  const canvas = canvasSize || config.canvasSize;
  const anchor = request?.anchor ?? 'bottom-right';
  const aspectRatio =
    Number.isFinite(request?.aspectRatio) && (request?.aspectRatio as number) > 0
      ? (request?.aspectRatio as number)
      : DEFAULT_WEBCAM_ASPECT_RATIO;
  const heightRatio = clamp(
    Number.isFinite(request?.heightRatio)
      ? (request?.heightRatio as number)
      : DEFAULT_WEBCAM_HEIGHT_RATIO,
    MIN_WEBCAM_HEIGHT_RATIO,
    MAX_WEBCAM_HEIGHT_RATIO,
  );

  const rawMargin = Number.isFinite(request?.marginPx)
    ? (request?.marginPx as number)
    : DEFAULT_WEBCAM_MARGIN_PX;
  const maxMargin = Math.floor(Math.min(canvas.width, canvas.height) / 2);
  const marginPx = clamp(Math.round(rawMargin), 0, Math.max(0, maxMargin));

  let height = Math.max(1, Math.round(canvas.height * heightRatio));
  let width = Math.max(1, Math.round(height * aspectRatio));

  const maxWidth = Math.max(
    1,
    Math.min(
      Math.round(canvas.width * MAX_WEBCAM_CANVAS_WIDTH_RATIO),
      Math.round(canvas.width - marginPx * 2),
    ),
  );
  const maxHeight = Math.max(
    1,
    Math.min(
      Math.round(canvas.height * MAX_WEBCAM_CANVAS_HEIGHT_RATIO),
      Math.round(canvas.height - marginPx * 2),
    ),
  );

  if (width > maxWidth) {
    width = maxWidth;
    height = Math.max(1, Math.round(width / aspectRatio));
  }

  if (height > maxHeight) {
    height = maxHeight;
    width = Math.max(1, Math.round(height * aspectRatio));
  }

  let x = marginPx;
  let y = marginPx;

  switch (anchor) {
    case 'top-right':
      x = canvas.width - width - marginPx;
      y = marginPx;
      break;
    case 'bottom-left':
      x = marginPx;
      y = canvas.height - height - marginPx;
      break;
    case 'bottom-right':
      x = canvas.width - width - marginPx;
      y = canvas.height - height - marginPx;
      break;
    case 'top-left':
    default:
      x = marginPx;
      y = marginPx;
      break;
  }

  x = clamp(Math.round(x), 0, Math.max(0, canvas.width - width));
  y = clamp(Math.round(y), 0, Math.max(0, canvas.height - height));

  return {
    x,
    y,
    width,
    height,
    scale: height / Math.max(1, canvas.height),
  };
}

/**
 * Reset configuration to defaults
 */
export function resetConfig(): void {
  config = { ...DEFAULT_COMPOSITOR_CONFIG };
}

/**
 * Generate FFmpeg filter string for compositing (stub for Phase 11)
 * This will be implemented when FFmpeg integration is added.
 *
 * @param videoPath - Path to input video
 * @param layout - Calculated layout result
 * @returns FFmpeg filter graph string
 */
export function generateFFmpegFilter(_videoPath: string, layout: LayoutResult): string {
  // Stub implementation - will be completed in Phase 11
  const filter = `scale=${layout.width}:${layout.height},pad=${config.canvasSize.width}:${config.canvasSize.height}:${layout.x}:${layout.y}:color=${config.backgroundColor}`;
  return filter;
}
