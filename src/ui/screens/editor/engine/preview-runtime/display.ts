import type { CanvasSize } from '../preview-config/types';
import type { CompositionLayout } from '../types';

export interface PreviewDisplaySize extends CanvasSize {
  scale: number;
}

export interface OverlayVideoLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function resolvePreviewDisplaySize(
  availableSize: CanvasSize,
  canvasSize: CanvasSize,
): PreviewDisplaySize {
  if (availableSize.width <= 0 || availableSize.height <= 0) {
    return {
      width: canvasSize.width,
      height: canvasSize.height,
      scale: 1,
    };
  }

  const scale = Math.min(
    availableSize.width / canvasSize.width,
    availableSize.height / canvasSize.height,
  );
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

  return {
    width: Math.max(1, Math.round(canvasSize.width * safeScale)),
    height: Math.max(1, Math.round(canvasSize.height * safeScale)),
    scale: safeScale,
  };
}

export function resolveOverlayVideoLayout(
  layout: CompositionLayout,
  previewScale: number,
): OverlayVideoLayout {
  return {
    x: layout.x * previewScale,
    y: layout.y * previewScale,
    width: layout.width * previewScale,
    height: layout.height * previewScale,
  };
}
