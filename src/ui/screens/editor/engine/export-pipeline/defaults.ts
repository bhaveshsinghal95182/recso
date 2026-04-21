export const DEFAULT_LAYOUT_CONFIG = {
  padding: 0.04,
  maxScale: 0.9,
  scaleUp: true,
};

export const DEFAULT_VIDEO_STYLE = {
  borderRadius: 24,
  borderWidth: 8,
  borderColor: 'rgba(255, 255, 255, 0.2)',
};

export const DEFAULT_WEBCAM_STYLE = {
  anchor: 'bottom-right' as const,
  shape: 'rectangle-portrait' as const,
  aspectRatio: 3 / 4,
  heightRatio: 0.34,
  marginPx: 24,
  borderRadius: 24,
  borderWidth: 0,
  borderColor: 'rgba(255, 255, 255, 0.42)',
  opacity: 1,
  shadows: [
    { offsetX: -1, offsetY: 2, blur: 4, color: 'rgba(0, 0, 0, 0.16)' },
    { offsetX: -3, offsetY: 6, blur: 10, color: 'rgba(0, 0, 0, 0.10)' },
    { offsetX: 0, offsetY: 1, blur: 2, color: 'rgba(0, 0, 0, 0.12)' },
  ],
};

export const DEFAULT_ZOOM_EPSILON = 0.001;
export const MAX_BACKGROUND_SNAPSHOT_SCALE = 2;
export const MAX_BACKGROUND_SNAPSHOT_PIXELS = 12_000_000;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampNormalised(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, value));
}
