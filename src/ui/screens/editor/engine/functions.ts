import type {
  BackgroundConfig,
  Canvas2DContext,
  CompositionConfig,
  CompositionCutRegion,
  CompositionZoomRegion,
  FrameVideoSource,
  VideoConfig,
  VideoLayout,
  ZoomKeyframe,
  ZoomState,
} from './types';

const DEFAULT_BACKGROUND_COLOR = '#000000';

export const defaultConfig: CompositionConfig = {
  background: {
    enabled: true,
    type: 'color',
    color: DEFAULT_BACKGROUND_COLOR,
  },
  video: {
    scale: 0.85,
    borderRadius: 24,
    border: {
      width: 0,
      color: '#ffffff',
    },
  },
  zooms: [],
  zoomRegions: [],
  cuts: [],
};

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

export function roundRectPath(
  ctx: Canvas2DContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const clamped = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  ctx.beginPath();
  ctx.moveTo(x + clamped, y);
  ctx.lineTo(x + width - clamped, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + clamped);
  ctx.lineTo(x + width, y + height - clamped);
  ctx.quadraticCurveTo(x + width, y + height, x + width - clamped, y + height);
  ctx.lineTo(x + clamped, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - clamped);
  ctx.lineTo(x, y + clamped);
  ctx.quadraticCurveTo(x, y, x + clamped, y);
  ctx.closePath();
}

export function computeVideoLayout(
  frameWidth: number,
  frameHeight: number,
  config: CompositionConfig,
): VideoLayout {
  if (config.layout) {
    return {
      x: config.layout.x,
      y: config.layout.y,
      width: config.layout.width,
      height: config.layout.height,
      scale: config.layout.scale,
    };
  }

  const videoScale = config.background.enabled ? config.video.scale : 1;
  const width = frameWidth * videoScale;
  const height = frameHeight * videoScale;
  const x = (frameWidth - width) / 2;
  const y = (frameHeight - height) / 2;

  return { x, y, width, height, scale: videoScale };
}

function clampNormalised(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

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

function normaliseCuts(cuts: CompositionCutRegion[]): CompositionCutRegion[] {
  const sorted = [...cuts]
    .map((cut) => ({
      ...cut,
      startMs: Math.max(0, cut.startMs),
      endMs: Math.max(0, cut.endMs),
    }))
    .filter((cut) => cut.endMs > cut.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged: CompositionCutRegion[] = [];
  for (const cut of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && cut.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, cut.endMs);
      continue;
    }

    merged.push({ ...cut });
  }

  return merged;
}

function getCutDurationBeforeTimeMs(timestampMs: number, cuts?: CompositionCutRegion[]): number {
  if (!cuts?.length) {
    return 0;
  }

  let skippedMs = 0;
  for (const cut of normaliseCuts(cuts)) {
    if (timestampMs <= cut.startMs) {
      break;
    }

    const cutEnd = Math.min(timestampMs, cut.endMs);
    if (cutEnd > cut.startMs) {
      skippedMs += cutEnd - cut.startMs;
    }
  }

  return skippedMs;
}

export function isInCutRegion(timestampMs: number, cuts?: CompositionCutRegion[]): boolean {
  if (!cuts?.length) {
    return false;
  }

  for (const cut of normaliseCuts(cuts)) {
    if (timestampMs >= cut.startMs && timestampMs < cut.endMs) {
      return true;
    }
  }

  return false;
}

export function mapCompositionToSourceTimeMs(
  compositionTimeMs: number,
  cuts?: CompositionCutRegion[],
): number {
  if (!cuts?.length) {
    return Math.max(0, compositionTimeMs);
  }

  let sourceMs = Math.max(0, compositionTimeMs);
  for (const cut of normaliseCuts(cuts)) {
    if (sourceMs < cut.startMs) {
      break;
    }

    sourceMs += cut.endMs - cut.startMs;
  }

  return sourceMs;
}

export function mapSourceTimeToCompositionTimeMs(
  sourceTimeMs: number,
  cuts?: CompositionCutRegion[],
): number {
  const safeTimeMs = Math.max(0, sourceTimeMs);
  return Math.max(0, safeTimeMs - getCutDurationBeforeTimeMs(safeTimeMs, cuts));
}

export function getCutAdjustedDurationMs(
  sourceDurationMs: number,
  cuts?: CompositionCutRegion[],
): number {
  const safeDurationMs = Math.max(0, sourceDurationMs);
  if (!cuts?.length) {
    return safeDurationMs;
  }

  return Math.max(0, safeDurationMs - getCutDurationBeforeTimeMs(safeDurationMs, cuts));
}

function resolveRegionFocalPoint(
  region: CompositionZoomRegion,
  timestampMs: number,
): { x: number; y: number } {
  const keyframes = region.focalKeyframes ?? [];
  if (keyframes.length === 0) {
    return {
      x: clampNormalised(region.focalX),
      y: clampNormalised(region.focalY),
    };
  }

  const points = [
    {
      timestampMs: region.startMs,
      focalX: clampNormalised(region.focalX),
      focalY: clampNormalised(region.focalY),
    },
    ...keyframes
      .map((point) => ({
        timestampMs: point.timestampMs,
        focalX: clampNormalised(point.focalX),
        focalY: clampNormalised(point.focalY),
      }))
      .sort((a, b) => a.timestampMs - b.timestampMs),
  ];

  if (timestampMs <= points[0].timestampMs) {
    return { x: points[0].focalX, y: points[0].focalY };
  }

  const lastPoint = points[points.length - 1];
  if (timestampMs >= lastPoint.timestampMs) {
    return { x: lastPoint.focalX, y: lastPoint.focalY };
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];

    if (timestampMs >= current.timestampMs && timestampMs <= next.timestampMs) {
      const range = next.timestampMs - current.timestampMs;
      if (range <= 0) {
        return { x: current.focalX, y: current.focalY };
      }

      const mix = (timestampMs - current.timestampMs) / range;
      return {
        x: lerp(current.focalX, next.focalX, mix),
        y: lerp(current.focalY, next.focalY, mix),
      };
    }
  }

  return { x: lastPoint.focalX, y: lastPoint.focalY };
}

export function computeZoomStateFromRegions(
  timestampMs: number,
  zoomRegions: CompositionZoomRegion[],
  frameWidth: number,
  frameHeight: number,
): ZoomState {
  let scale = 1;
  let pivotX = frameWidth / 2;
  let pivotY = frameHeight / 2;

  for (const region of zoomRegions) {
    if (timestampMs >= region.startMs && timestampMs <= region.endMs) {
      const easeDurationMs = Math.max(0, region.easeDurationMs);
      let eased = 1;

      if (easeDurationMs > 0 && timestampMs < region.startMs + easeDurationMs) {
        eased = smoothstep((timestampMs - region.startMs) / easeDurationMs);
      } else if (easeDurationMs > 0 && timestampMs > region.endMs - easeDurationMs) {
        eased = smoothstep((region.endMs - timestampMs) / easeDurationMs);
      }

      scale = 1 + (region.zoomLevel - 1) * eased;
      const focal = resolveRegionFocalPoint(region, timestampMs);
      pivotX = focal.x * frameWidth;
      pivotY = focal.y * frameHeight;
      break;
    }
  }

  return { scale, pivotX, pivotY };
}

export function computeZoomState(
  t: number,
  zooms: ZoomKeyframe[],
  frameWidth: number,
  frameHeight: number,
): ZoomState {
  let scale = 1;
  let pivotX = frameWidth / 2;
  let pivotY = frameHeight / 2;

  for (const zoom of zooms) {
    if (t >= zoom.startTime && t <= zoom.endTime) {
      const easeIn = zoom.easeIn ?? 0.3;
      const easeOut = zoom.easeOut ?? 0.3;
      let eased = 1;

      if (t < zoom.startTime + easeIn && easeIn > 0) {
        eased = smoothstep((t - zoom.startTime) / easeIn);
      } else if (t > zoom.endTime - easeOut && easeOut > 0) {
        eased = smoothstep((zoom.endTime - t) / easeOut);
      }

      scale = 1 + (zoom.multiplier - 1) * eased;
      pivotX = zoom.focalPoint.x * frameWidth;
      pivotY = zoom.focalPoint.y * frameHeight;
      break;
    }
  }

  return { scale, pivotX, pivotY };
}

export function computeZoomStateFromConfig(
  t: number,
  config: CompositionConfig,
  frameWidth: number,
  frameHeight: number,
): ZoomState {
  if (config.zoomRegions && config.zoomRegions.length > 0) {
    return computeZoomStateFromRegions(t * 1000, config.zoomRegions, frameWidth, frameHeight);
  }

  return computeZoomState(t, config.zooms, frameWidth, frameHeight);
}

export function drawVideoLayer(
  ctx: Canvas2DContext,
  layout: VideoLayout,
  videoConfig: VideoConfig,
  source: FrameVideoSource,
): void {
  if (videoConfig.borderRadius > 0 || videoConfig.border.width > 0) {
    ctx.save();

    if (videoConfig.border.width > 0) {
      const borderWidth = videoConfig.border.width;
      roundRectPath(
        ctx,
        layout.x - borderWidth,
        layout.y - borderWidth,
        layout.width + borderWidth * 2,
        layout.height + borderWidth * 2,
        videoConfig.borderRadius + borderWidth,
      );
      ctx.fillStyle = videoConfig.border.color;
      ctx.fill();
    }

    roundRectPath(ctx, layout.x, layout.y, layout.width, layout.height, videoConfig.borderRadius);
    ctx.clip();

    source.draw(ctx, layout.x, layout.y, layout.width, layout.height);
    ctx.restore();
    return;
  }

  source.draw(ctx, layout.x, layout.y, layout.width, layout.height);
}

export interface RenderCompositionFrameOptions {
  ctx: Canvas2DContext;
  frameWidth: number;
  frameHeight: number;
  t: number;
  config: CompositionConfig;
  source: FrameVideoSource;
}

export function renderCompositionFrame({
  ctx,
  frameWidth,
  frameHeight,
  t,
  config,
  source,
}: RenderCompositionFrameOptions): void {
  const zoomState = computeZoomStateFromConfig(t, config, frameWidth, frameHeight);
  const videoLayout = computeVideoLayout(frameWidth, frameHeight, config);

  ctx.save();
  ctx.translate(zoomState.pivotX, zoomState.pivotY);
  ctx.scale(zoomState.scale, zoomState.scale);
  ctx.translate(-zoomState.pivotX, -zoomState.pivotY);

  if (config.background.enabled) {
    drawBackground(ctx, frameWidth, frameHeight, config.background);
  } else {
    ctx.clearRect(0, 0, frameWidth, frameHeight);
  }

  drawVideoLayer(ctx, videoLayout, config.video, source);
  ctx.restore();
}
