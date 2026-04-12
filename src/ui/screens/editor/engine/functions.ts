import type {
  BackgroundConfig,
  Canvas2DContext,
  CompositionConfig,
  CompositionCursorConfig,
  CompositionCursorEvent,
  CompositionCutRegion,
  CompositionZoomRegion,
  FrameVideoSource,
  VideoConfig,
  VideoLayout,
  ZoomKeyframe,
  ZoomState,
} from './types';

const DEFAULT_BACKGROUND_COLOR = '#000000';
const DEFAULT_CURSOR_SIZE_PX = 22;
const MAX_CURSOR_INTERPOLATION_GAP_MS = 220;
const cursorImageCache = new Map<string, HTMLImageElement | null>();
const cursorImageLoading = new Set<string>();

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

interface CursorSample {
  normalizedX: number;
  normalizedY: number;
  clickProgress?: number;
  button?: 'left' | 'right' | 'middle';
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function toFileUrl(rawPath: string | undefined): string | null {
  if (!rawPath) {
    return null;
  }

  if (rawPath.startsWith('file:')) {
    return rawPath;
  }

  const normalized = rawPath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }

  if (normalized.startsWith('/')) {
    return `file://${encodeURI(normalized)}`;
  }

  return normalized;
}

function getCustomCursorImage(path: string | undefined): HTMLImageElement | null {
  const sourceUrl = toFileUrl(path);
  if (!sourceUrl) {
    return null;
  }

  if (cursorImageCache.has(sourceUrl)) {
    return cursorImageCache.get(sourceUrl) ?? null;
  }

  if (cursorImageLoading.has(sourceUrl) || typeof Image === 'undefined') {
    return null;
  }

  cursorImageLoading.add(sourceUrl);
  const image = new Image();
  image.onload = () => {
    cursorImageCache.set(sourceUrl, image);
    cursorImageLoading.delete(sourceUrl);
  };
  image.onerror = () => {
    cursorImageCache.set(sourceUrl, null);
    cursorImageLoading.delete(sourceUrl);
  };
  image.src = sourceUrl;

  return null;
}

function findUpperBoundEventIndex(events: CompositionCursorEvent[], timestampMs: number): number {
  let low = 0;
  let high = events.length;

  while (low < high) {
    const mid = low + ((high - low) >> 1);
    if (events[mid].timestampMs <= timestampMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function resolveEventNormalisedPosition(
  event: CompositionCursorEvent | undefined,
  cursor: CompositionCursorConfig,
): { x: number; y: number } | null {
  if (!event) {
    return null;
  }

  if (Number.isFinite(event.normalizedX) && Number.isFinite(event.normalizedY)) {
    return {
      x: clampUnit(event.normalizedX as number),
      y: clampUnit(event.normalizedY as number),
    };
  }

  if (cursor.sourceWidth > 0 && cursor.sourceHeight > 0) {
    return {
      x: clampUnit(event.x / cursor.sourceWidth),
      y: clampUnit(event.y / cursor.sourceHeight),
    };
  }

  return null;
}

function resolveCursorSample(
  cursor: CompositionCursorConfig,
  timestampMs: number,
): CursorSample | null {
  const events = cursor.events;
  if (events.length === 0) {
    return null;
  }

  const afterIndex = findUpperBoundEventIndex(events, timestampMs);
  const beforeEvent = afterIndex > 0 ? events[afterIndex - 1] : undefined;
  const afterEvent = afterIndex < events.length ? events[afterIndex] : undefined;

  const beforePosition = resolveEventNormalisedPosition(beforeEvent, cursor);
  const afterPosition = resolveEventNormalisedPosition(afterEvent, cursor);

  let normalizedX: number | null = null;
  let normalizedY: number | null = null;

  if (beforePosition && afterPosition && beforeEvent && afterEvent) {
    const eventGapMs = afterEvent.timestampMs - beforeEvent.timestampMs;
    if (eventGapMs > 0 && eventGapMs <= MAX_CURSOR_INTERPOLATION_GAP_MS) {
      const mix = clampUnit((timestampMs - beforeEvent.timestampMs) / eventGapMs);
      normalizedX = lerp(beforePosition.x, afterPosition.x, mix);
      normalizedY = lerp(beforePosition.y, afterPosition.y, mix);
    }
  }

  if (normalizedX === null || normalizedY === null) {
    const fallbackPosition = beforePosition ?? afterPosition;
    if (!fallbackPosition) {
      return null;
    }

    normalizedX = fallbackPosition.x;
    normalizedY = fallbackPosition.y;
  }

  let clickProgress: number | undefined;
  let button: 'left' | 'right' | 'middle' | undefined;

  if (cursor.showClickAnimations) {
    const displayWindowMs = Math.max(1, cursor.clickDisplayDuration);
    for (let index = afterIndex - 1; index >= 0; index -= 1) {
      const event = events[index];
      const ageMs = timestampMs - event.timestampMs;

      if (ageMs > displayWindowMs) {
        break;
      }

      if (event.eventType === 'click') {
        clickProgress = clampUnit(ageMs / displayWindowMs);
        button = event.button;
        break;
      }
    }
  }

  return {
    normalizedX: clampUnit(normalizedX),
    normalizedY: clampUnit(normalizedY),
    clickProgress,
    button,
  };
}

function drawArrowCursor(
  ctx: Canvas2DContext,
  x: number,
  y: number,
  size: number,
  fillColor: string,
  strokeColor: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(size * 0.72, size * 1.82);
  ctx.lineTo(size * 0.47, size * 1.8);
  ctx.lineTo(size * 0.31, size * 2.28);
  ctx.lineTo(size * 0.08, size * 2.18);
  ctx.lineTo(size * 0.24, size * 1.7);
  ctx.lineTo(0, size * 1.7);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.lineWidth = Math.max(1, size * 0.09);
  ctx.strokeStyle = strokeColor;
  ctx.stroke();
  ctx.restore();
}

function drawCrosshairCursor(ctx: Canvas2DContext, x: number, y: number, size: number): void {
  const radius = size * 0.5;
  const arm = radius * 1.5;

  ctx.save();
  ctx.lineWidth = Math.max(1, size * 0.08);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.beginPath();
  ctx.moveTo(x - arm, y);
  ctx.lineTo(x + arm, y);
  ctx.moveTo(x, y - arm);
  ctx.lineTo(x, y + arm);
  ctx.stroke();

  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.beginPath();
  ctx.moveTo(x - arm * 0.9, y);
  ctx.lineTo(x + arm * 0.9, y);
  ctx.moveTo(x, y - arm * 0.9);
  ctx.lineTo(x, y + arm * 0.9);
  ctx.stroke();

  ctx.beginPath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.arc(x, y, radius * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawClickAnimation(
  ctx: Canvas2DContext,
  x: number,
  y: number,
  cursorSize: number,
  clickProgress: number,
  clickScale: number,
  button: 'left' | 'right' | 'middle' | undefined,
): void {
  const eased = smoothstep(1 - clampUnit(clickProgress));
  const maxRadius = cursorSize * Math.max(1.35, clickScale * 1.3);
  const radius = lerp(cursorSize * 0.22, maxRadius, eased);
  const alpha = 0.42 * (1 - clampUnit(clickProgress));

  const baseColor =
    button === 'right'
      ? `rgba(255, 145, 110, ${alpha})`
      : button === 'middle'
        ? `rgba(120, 210, 255, ${alpha})`
        : `rgba(255, 255, 255, ${alpha})`;

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = baseColor;
  ctx.lineWidth = Math.max(1, cursorSize * 0.09);
  ctx.stroke();
  ctx.restore();
}

function drawCursorGlyph(
  ctx: Canvas2DContext,
  x: number,
  y: number,
  cursorSize: number,
  cursor: CompositionCursorConfig,
): void {
  if (cursor.style === 'crosshair') {
    drawCrosshairCursor(ctx, x, y, cursorSize);
    return;
  }

  if (cursor.style === 'custom') {
    const image = getCustomCursorImage(cursor.customImagePath);
    if (image) {
      const sourceWidth = image.naturalWidth || image.width || 1;
      const sourceHeight = image.naturalHeight || image.height || 1;
      const aspectRatio = sourceWidth / sourceHeight;
      const drawHeight = cursorSize * 2;
      const drawWidth = Math.max(1, drawHeight * aspectRatio);
      ctx.drawImage(image, x, y, drawWidth, drawHeight);
      return;
    }
  }

  if (cursor.style === 'pointer') {
    drawArrowCursor(ctx, x, y, cursorSize, 'rgba(35, 176, 255, 0.95)', 'rgba(255, 255, 255, 0.96)');
    return;
  }

  drawArrowCursor(ctx, x, y, cursorSize, 'rgba(18, 18, 20, 0.96)', 'rgba(255, 255, 255, 0.95)');
}

function drawCursorLayer(
  ctx: Canvas2DContext,
  t: number,
  layout: VideoLayout,
  cursor: CompositionCursorConfig | undefined,
): void {
  if (!cursor?.enabled || cursor.events.length === 0 || layout.width <= 0 || layout.height <= 0) {
    return;
  }

  const sample = resolveCursorSample(cursor, t * 1000);
  if (!sample) {
    return;
  }

  // Map cursor into the effective video content rect. This keeps cursor placement exact even when
  // backend layout introduces centered padding/offset after scaling the source.
  const sourceScaledWidth =
    cursor.sourceWidth > 0 ? cursor.sourceWidth * layout.scale : layout.width;
  const sourceScaledHeight =
    cursor.sourceHeight > 0 ? cursor.sourceHeight * layout.scale : layout.height;
  const contentWidth = Math.max(1, Math.min(layout.width, sourceScaledWidth));
  const contentHeight = Math.max(1, Math.min(layout.height, sourceScaledHeight));
  const contentX = layout.x + (layout.width - contentWidth) / 2;
  const contentY = layout.y + (layout.height - contentHeight) / 2;

  const cursorX = contentX + sample.normalizedX * contentWidth;
  const cursorY = contentY + sample.normalizedY * contentHeight;
  const sourceScaleX = cursor.sourceWidth > 0 ? contentWidth / cursor.sourceWidth : 1;
  const sourceScaleY = cursor.sourceHeight > 0 ? contentHeight / cursor.sourceHeight : 1;
  const sourceScale = Math.max(0.35, Math.min(3, (sourceScaleX + sourceScaleY) / 2));
  const cursorSize = Math.max(8, DEFAULT_CURSOR_SIZE_PX * Math.max(0.2, cursor.size) * sourceScale);

  if (cursor.showClickAnimations && typeof sample.clickProgress === 'number') {
    drawClickAnimation(
      ctx,
      cursorX,
      cursorY,
      cursorSize,
      sample.clickProgress,
      Math.max(1, cursor.clickAnimationScale),
      sample.button,
    );
  }

  drawCursorGlyph(ctx, cursorX, cursorY, cursorSize, cursor);
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
  drawCursorLayer(ctx, t, videoLayout, config.cursor);
  ctx.restore();
}
