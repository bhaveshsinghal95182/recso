/**
 * CompositorService — compositor configuration held by the main process.
 *
 * Responsibilities:
 * - Manages compositor configuration (background, canvas size)
 * - Calculates the webcam overlay placement on the canvas
 *
 * Note: This service does NOT render pixels, and it does not decide how the
 * recording is framed. The renderer owns that math
 * (`src/ui/screens/editor/engine/canvas-layout.ts`) and drives both the preview
 * and the export from the project's stored `canvasPadding`.
 */

import fs from 'fs';
import path from 'path';

import type {
  CompositorConfig,
  LayoutResult,
  Size,
  WebcamAnchor,
  WebcamLayoutRequest,
  WebcamLayoutResult,
} from '../types/compositor.types.js';
import { DEFAULT_COMPOSITOR_CONFIG } from '../types/compositor.types.js';

const DEFAULT_WEBCAM_ASPECT_RATIO = 3 / 4;
const DEFAULT_WEBCAM_HEIGHT_RATIO = 0.34;
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
 * Anchor fractions for the 3x3 placement grid — 0 pins the leading edge, 1 the
 * trailing edge, 0.5 centres the box.
 *
 * This duplicates `src/ui/screens/editor/engine/webcam-anchor.ts` because the
 * Electron tsconfig sets `rootDir: "."`, so main-process code cannot import from
 * `src/ui` without restructuring the build output. The two must stay in sync:
 * the renderer uses its copy as the offline fallback for this very function.
 */
const ANCHOR_FRACTIONS: Record<WebcamAnchor, { x: number; y: number }> = {
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

/**
 * Calculate a webcam overlay layout on the canvas.
 *
 * Defaults:
 * - bottom-right anchor
 * - 3:4 portrait aspect ratio
 * - 34% of canvas height
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

  const fractions = ANCHOR_FRACTIONS[anchor] ?? ANCHOR_FRACTIONS['bottom-right'];
  let x = marginPx + (canvas.width - width - marginPx * 2) * fractions.x;
  let y = marginPx + (canvas.height - height - marginPx * 2) * fractions.y;

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
