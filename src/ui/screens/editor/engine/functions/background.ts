import type { BackgroundConfig, Canvas2DContext } from '../types';
import { clampNormalised, DEFAULT_BACKGROUND_COLOR } from './common';

function resolveValue(value: number | undefined, size: number, fallbackRatio: number): number {
  if (!Number.isFinite(value)) {
    return size * fallbackRatio;
  }

  const safeValue = value as number;
  if (safeValue >= -1 && safeValue <= 1) {
    return safeValue * size;
  }

  return safeValue;
}

function applyStops(
  gradient: CanvasGradient,
  stops: BackgroundConfig['stops'],
  fallback: string,
): void {
  if (!stops || stops.length === 0) {
    gradient.addColorStop(0, fallback);
    gradient.addColorStop(1, fallback);
    return;
  }

  const sorted = [...stops]
    .map((stop) => ({
      color: stop.color || fallback,
      position: clampNormalised(stop.position),
    }))
    .sort((a, b) => a.position - b.position);

  if (sorted[0].position > 0) {
    gradient.addColorStop(0, sorted[0].color);
  }

  for (const stop of sorted) {
    gradient.addColorStop(stop.position, stop.color);
  }

  const last = sorted[sorted.length - 1];
  if (last.position < 1) {
    gradient.addColorStop(1, last.color);
  }
}

function drawLinearGradientBackground(
  ctx: Canvas2DContext,
  frameWidth: number,
  frameHeight: number,
  background: BackgroundConfig,
): void {
  const angleDeg = Number.isFinite(background.angle) ? (background.angle as number) : 180;
  const radians = ((angleDeg - 90) * Math.PI) / 180;
  const cx = frameWidth / 2;
  const cy = frameHeight / 2;
  const distance = Math.sqrt(frameWidth * frameWidth + frameHeight * frameHeight) / 2;
  const dx = Math.cos(radians) * distance;
  const dy = Math.sin(radians) * distance;

  const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  applyStops(gradient, background.stops, background.color ?? DEFAULT_BACKGROUND_COLOR);

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, frameWidth, frameHeight);
}

function drawRadialGradientBackground(
  ctx: Canvas2DContext,
  frameWidth: number,
  frameHeight: number,
  background: BackgroundConfig,
): void {
  const centerX = resolveValue(background.cx, frameWidth, 0.5);
  const centerY = resolveValue(background.cy, frameHeight, 0.5);
  const radiusX = Math.max(1, resolveValue(background.radiusX, frameWidth, 0.6));
  const radiusY = Math.max(1, resolveValue(background.radiusY, frameHeight, 0.6));
  const maxRadius = Math.max(radiusX, radiusY);
  const scaleX = radiusX / maxRadius;
  const scaleY = radiusY / maxRadius;
  const fillColor = background.color ?? DEFAULT_BACKGROUND_COLOR;

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.scale(scaleX, scaleY);

  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, maxRadius);
  applyStops(gradient, background.stops, fillColor);

  ctx.fillStyle = gradient;
  ctx.fillRect(-centerX / scaleX, -centerY / scaleY, frameWidth / scaleX, frameHeight / scaleY);
  ctx.restore();
}

function applyCrossHatchMask(
  ctx: Canvas2DContext,
  frameWidth: number,
  frameHeight: number,
  mask: NonNullable<BackgroundConfig['mask']>,
): void {
  const centerX = resolveValue(mask.cx, frameWidth, 0.5);
  const centerY = resolveValue(mask.cy, frameHeight, 0.5);
  const radiusX = Math.max(1, resolveValue(mask.rx, frameWidth, 0.65));
  const radiusY = Math.max(1, resolveValue(mask.ry, frameHeight, 0.65));
  const innerStop = clampNormalised(mask.innerStop);
  const outerStop = Math.max(innerStop, clampNormalised(mask.outerStop));

  const maxRadius = Math.max(radiusX, radiusY);
  const scaleX = radiusX / maxRadius;
  const scaleY = radiusY / maxRadius;

  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.translate(centerX, centerY);
  ctx.scale(scaleX, scaleY);

  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, maxRadius);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(innerStop, 'rgba(255,255,255,1)');
  gradient.addColorStop(outerStop, 'rgba(255,255,255,0)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');

  ctx.fillStyle = gradient;
  ctx.fillRect(-centerX / scaleX, -centerY / scaleY, frameWidth / scaleX, frameHeight / scaleY);
  ctx.restore();
}

function drawCrossHatchBackground(
  ctx: Canvas2DContext,
  frameWidth: number,
  frameHeight: number,
  background: BackgroundConfig,
): void {
  const baseColor = background.backgroundColor ?? background.color ?? '#111111';
  const lineColor = background.lineColor ?? 'rgba(255,255,255,0.14)';
  const lineWidth = Math.max(0.5, background.lineWidth ?? 1);
  const spacing = Math.max(4, background.cellSize ?? 28);

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, frameWidth, frameHeight);

  ctx.save();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();

  for (let x = -frameHeight; x <= frameWidth + frameHeight; x += spacing) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x + frameHeight, frameHeight);
    ctx.moveTo(x, frameHeight);
    ctx.lineTo(x + frameHeight, 0);
  }

  ctx.stroke();
  ctx.restore();

  if (background.mask) {
    applyCrossHatchMask(ctx, frameWidth, frameHeight, background.mask);
  }
}

export function drawBackground(
  ctx: Canvas2DContext,
  frameWidth: number,
  frameHeight: number,
  background: BackgroundConfig,
): void {
  switch (background.type) {
    case 'linearGradient':
      drawLinearGradientBackground(ctx, frameWidth, frameHeight, background);
      return;
    case 'radialGradient':
      drawRadialGradientBackground(ctx, frameWidth, frameHeight, background);
      return;
    case 'crossHatch':
      drawCrossHatchBackground(ctx, frameWidth, frameHeight, background);
      return;
    case 'color':
    default:
      ctx.fillStyle = background.color ?? DEFAULT_BACKGROUND_COLOR;
      ctx.fillRect(0, 0, frameWidth, frameHeight);
  }
}
