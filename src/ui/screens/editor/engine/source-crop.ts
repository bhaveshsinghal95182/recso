export interface SourceCropConfig {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface SourceDimensions {
  width: number;
  height: number;
}

export interface CropLocalCursorPosition {
  x: number;
  y: number;
  normalizedX: number;
  normalizedY: number;
}

const MIN_VISIBLE_FRACTION = 0.05;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return clamp(value, 0, 1);
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function resolveSourceCrop(
  crop: SourceCropConfig | null | undefined,
): SourceCropConfig | null {
  if (!crop) {
    return null;
  }

  const top = clamp(finiteOrZero(Number(crop.top)), 0, 1 - MIN_VISIBLE_FRACTION);
  const left = clamp(finiteOrZero(Number(crop.left)), 0, 1 - MIN_VISIBLE_FRACTION);
  const bottom = clamp(finiteOrZero(Number(crop.bottom)), 0, 1 - MIN_VISIBLE_FRACTION);
  const right = clamp(finiteOrZero(Number(crop.right)), 0, 1 - MIN_VISIBLE_FRACTION);

  const visibleWidth = 1 - left - right;
  const visibleHeight = 1 - top - bottom;

  if (visibleWidth < MIN_VISIBLE_FRACTION || visibleHeight < MIN_VISIBLE_FRACTION) {
    return null;
  }

  if (top === 0 && left === 0 && bottom === 0 && right === 0) {
    return null;
  }

  return { top, left, bottom, right };
}

export function hasSourceCrop(crop: SourceCropConfig | null | undefined): boolean {
  return resolveSourceCrop(crop) !== null;
}

export function resolveCroppedSourceDimensions(
  dimensions: SourceDimensions,
  crop: SourceCropConfig | null | undefined,
): SourceDimensions {
  const width = Math.max(1, Math.round(dimensions.width || 1));
  const height = Math.max(1, Math.round(dimensions.height || 1));
  const resolvedCrop = resolveSourceCrop(crop);

  if (!resolvedCrop) {
    return { width, height };
  }

  return {
    width: Math.max(1, Math.round(width * (1 - resolvedCrop.left - resolvedCrop.right))),
    height: Math.max(1, Math.round(height * (1 - resolvedCrop.top - resolvedCrop.bottom))),
  };
}

export function resolveCropLocalCursorPosition(
  event: {
    x: number;
    y: number;
    normalizedX?: number;
    normalizedY?: number;
  },
  sourceDimensions: SourceDimensions,
  crop: SourceCropConfig | null | undefined,
): CropLocalCursorPosition {
  const sourceWidth = Math.max(1, sourceDimensions.width || 1);
  const sourceHeight = Math.max(1, sourceDimensions.height || 1);
  const resolvedCrop = resolveSourceCrop(crop);

  if (!resolvedCrop) {
    const normalizedX = Number.isFinite(event.normalizedX)
      ? clampUnit(event.normalizedX as number)
      : clampUnit(event.x / sourceWidth);
    const normalizedY = Number.isFinite(event.normalizedY)
      ? clampUnit(event.normalizedY as number)
      : clampUnit(event.y / sourceHeight);

    return {
      x: normalizedX * sourceWidth,
      y: normalizedY * sourceHeight,
      normalizedX,
      normalizedY,
    };
  }

  const croppedDimensions = resolveCroppedSourceDimensions(
    { width: sourceWidth, height: sourceHeight },
    resolvedCrop,
  );
  const sourceX = Number.isFinite(event.normalizedX)
    ? clampUnit(event.normalizedX as number) * sourceWidth
    : event.x;
  const sourceY = Number.isFinite(event.normalizedY)
    ? clampUnit(event.normalizedY as number) * sourceHeight
    : event.y;
  const cropLocalX = sourceX - sourceWidth * resolvedCrop.left;
  const cropLocalY = sourceY - sourceHeight * resolvedCrop.top;
  const normalizedX = clampUnit(cropLocalX / croppedDimensions.width);
  const normalizedY = clampUnit(cropLocalY / croppedDimensions.height);

  return {
    x: normalizedX * croppedDimensions.width,
    y: normalizedY * croppedDimensions.height,
    normalizedX,
    normalizedY,
  };
}
