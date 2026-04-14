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
  WebcamOverlayConfig,
  ZoomKeyframe,
  ZoomState,
} from './types';

const DEFAULT_BACKGROUND_COLOR = '#000000';
const DEFAULT_CURSOR_SIZE_PX = 22;
const MOTION_BLUR_TRAIL_MS = 90;
const MAX_MOTION_BLUR_EVENT_GAP_MS = 260;
const MOTION_BLUR_SPEED_SCALE = 220;
const DEFAULT_WEBCAM_ASPECT_RATIO = 9 / 16;
const DEFAULT_WEBCAM_HEIGHT_RATIO = 0.28;
const DEFAULT_WEBCAM_MARGIN_PX = 24;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

export function computeWebcamLayout(
  frameWidth: number,
  frameHeight: number,
  webcamConfig: WebcamOverlayConfig,
): VideoLayout {
  if (webcamConfig.layout) {
    return {
      x: webcamConfig.layout.x,
      y: webcamConfig.layout.y,
      width: webcamConfig.layout.width,
      height: webcamConfig.layout.height,
      scale: webcamConfig.layout.scale,
    };
  }

  const aspectRatio =
    Number.isFinite(webcamConfig.aspectRatio) && webcamConfig.aspectRatio > 0
      ? webcamConfig.aspectRatio
      : DEFAULT_WEBCAM_ASPECT_RATIO;
  const heightRatio = clamp(
    Number.isFinite(webcamConfig.heightRatio)
      ? webcamConfig.heightRatio
      : DEFAULT_WEBCAM_HEIGHT_RATIO,
    0.08,
    0.75,
  );
  const margin = clamp(
    Math.round(
      Number.isFinite(webcamConfig.marginPx) ? webcamConfig.marginPx : DEFAULT_WEBCAM_MARGIN_PX,
    ),
    0,
    Math.max(0, Math.floor(Math.min(frameWidth, frameHeight) / 2)),
  );

  let height = Math.max(1, Math.round(frameHeight * heightRatio));
  let width = Math.max(1, Math.round(height * aspectRatio));

  const maxWidth = Math.max(1, frameWidth - margin * 2);
  const maxHeight = Math.max(1, frameHeight - margin * 2);

  if (width > maxWidth) {
    width = maxWidth;
    height = Math.max(1, Math.round(width / aspectRatio));
  }

  if (height > maxHeight) {
    height = maxHeight;
    width = Math.max(1, Math.round(height * aspectRatio));
  }

  let x = margin;
  let y = margin;
  switch (webcamConfig.anchor) {
    case 'top-right':
      x = frameWidth - width - margin;
      y = margin;
      break;
    case 'bottom-left':
      x = margin;
      y = frameHeight - height - margin;
      break;
    case 'bottom-right':
      x = frameWidth - width - margin;
      y = frameHeight - height - margin;
      break;
    case 'top-left':
    default:
      x = margin;
      y = margin;
      break;
  }

  x = clamp(Math.round(x), 0, Math.max(0, frameWidth - width));
  y = clamp(Math.round(y), 0, Math.max(0, frameHeight - height));

  return {
    x,
    y,
    width,
    height,
    scale: height / Math.max(1, frameHeight),
  };
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

function drawWebcamShadowLayers(
  ctx: Canvas2DContext,
  layout: VideoLayout,
  webcamConfig: WebcamOverlayConfig,
): void {
  if (!webcamConfig.shadows || webcamConfig.shadows.length === 0) {
    return;
  }

  for (const shadow of webcamConfig.shadows) {
    const blur = Number.isFinite(shadow.blur) ? Math.max(0, shadow.blur) : 0;
    if (blur <= 0 && shadow.offsetX === 0 && shadow.offsetY === 0) {
      continue;
    }

    ctx.save();
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = shadow.offsetX;
    ctx.shadowOffsetY = shadow.offsetY;
    roundRectPath(ctx, layout.x, layout.y, layout.width, layout.height, webcamConfig.borderRadius);
    // The webcam layer is drawn immediately after this, so the fill is covered.
    // Keep fill opaque so low-alpha shadows remain visible.
    ctx.fillStyle = 'rgba(0, 0, 0, 1)';
    ctx.fill();
    ctx.restore();
  }
}

export function drawWebcamLayer(
  ctx: Canvas2DContext,
  frameWidth: number,
  frameHeight: number,
  webcamConfig: WebcamOverlayConfig,
  source: FrameVideoSource,
): void {
  const layout = computeWebcamLayout(frameWidth, frameHeight, webcamConfig);

  drawWebcamShadowLayers(ctx, layout, webcamConfig);

  ctx.save();
  const opacity = clamp(Number.isFinite(webcamConfig.opacity) ? webcamConfig.opacity : 1, 0, 1);
  if (opacity < 1) {
    ctx.globalAlpha = opacity;
  }

  if (webcamConfig.border.width > 0) {
    const borderWidth = webcamConfig.border.width;
    roundRectPath(
      ctx,
      layout.x - borderWidth,
      layout.y - borderWidth,
      layout.width + borderWidth * 2,
      layout.height + borderWidth * 2,
      webcamConfig.borderRadius + borderWidth,
    );
    ctx.fillStyle = webcamConfig.border.color;
    ctx.fill();
  }

  roundRectPath(ctx, layout.x, layout.y, layout.width, layout.height, webcamConfig.borderRadius);
  ctx.clip();
  source.draw(ctx, layout.x, layout.y, layout.width, layout.height);
  ctx.restore();
}

interface CursorSample {
  normalizedX: number;
  normalizedY: number;
  cursorDataUrl?: string;
  cursorHotspotX?: number;
  cursorHotspotY?: number;
  motionBlurFromX?: number;
  motionBlurFromY?: number;
  motionBlurIntensity?: number;
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
  const previousEvent = afterIndex > 1 ? events[afterIndex - 2] : undefined;
  const afterEvent = afterIndex < events.length ? events[afterIndex] : undefined;

  const beforePosition = resolveEventNormalisedPosition(beforeEvent, cursor);
  const previousPosition = resolveEventNormalisedPosition(previousEvent, cursor);
  const afterPosition = resolveEventNormalisedPosition(afterEvent, cursor);
  const resolvedPosition = beforePosition ?? afterPosition;
  const sourceEvent = beforeEvent ?? afterEvent;
  if (!resolvedPosition) {
    return null;
  }

  let motionBlurFromX: number | undefined;
  let motionBlurFromY: number | undefined;
  let motionBlurIntensity: number | undefined;

  if (
    cursor.showMotionBlur &&
    cursor.motionBlurStrength > 0 &&
    beforeEvent &&
    previousEvent &&
    beforePosition &&
    previousPosition
  ) {
    const gapMs = beforeEvent.timestampMs - previousEvent.timestampMs;
    const ageMs = timestampMs - beforeEvent.timestampMs;

    if (
      gapMs > 0 &&
      gapMs <= MAX_MOTION_BLUR_EVENT_GAP_MS &&
      ageMs >= 0 &&
      ageMs <= MOTION_BLUR_TRAIL_MS
    ) {
      const distance = Math.hypot(
        beforePosition.x - previousPosition.x,
        beforePosition.y - previousPosition.y,
      );
      const speedFactor = clampUnit((distance / gapMs) * MOTION_BLUR_SPEED_SCALE);
      const ageFactor = 1 - ageMs / MOTION_BLUR_TRAIL_MS;
      const strength = Math.max(0, cursor.motionBlurStrength);
      const intensity = clampUnit(speedFactor * ageFactor * strength);

      if (intensity > 0.015) {
        motionBlurFromX = previousPosition.x;
        motionBlurFromY = previousPosition.y;
        motionBlurIntensity = intensity;
      }
    }
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
    normalizedX: clampUnit(resolvedPosition.x),
    normalizedY: clampUnit(resolvedPosition.y),
    cursorDataUrl:
      sourceEvent && typeof sourceEvent.cursorDataUrl === 'string'
        ? sourceEvent.cursorDataUrl
        : undefined,
    cursorHotspotX:
      sourceEvent && Number.isFinite(sourceEvent.cursorHotspotX)
        ? sourceEvent.cursorHotspotX
        : undefined,
    cursorHotspotY:
      sourceEvent && Number.isFinite(sourceEvent.cursorHotspotY)
        ? sourceEvent.cursorHotspotY
        : undefined,
    motionBlurFromX,
    motionBlurFromY,
    motionBlurIntensity,
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
  eventCursorDataUrl?: string,
  eventCursorHotspotX?: number,
  eventCursorHotspotY?: number,
): void {
  const drawCursorImage = (
    imageSource: string | undefined,
    hotspotX?: number,
    hotspotY?: number,
  ): boolean => {
    const image = getCustomCursorImage(imageSource);
    if (!image) {
      return false;
    }

    const sourceWidth = image.naturalWidth || image.width || 1;
    const sourceHeight = image.naturalHeight || image.height || 1;
    const aspectRatio = sourceWidth / sourceHeight;
    const drawHeight = cursorSize * 2;
    const drawWidth = Math.max(1, drawHeight * aspectRatio);

    let drawX = x;
    let drawY = y;
    if (Number.isFinite(hotspotX) && Number.isFinite(hotspotY)) {
      const safeHotspotX = Math.max(0, hotspotX as number);
      const safeHotspotY = Math.max(0, hotspotY as number);
      drawX = x - (safeHotspotX / sourceWidth) * drawWidth;
      drawY = y - (safeHotspotY / sourceHeight) * drawHeight;
    }

    ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
    return true;
  };

  if (drawCursorImage(eventCursorDataUrl, eventCursorHotspotX, eventCursorHotspotY)) {
    return;
  }

  if (cursor.style === 'crosshair') {
    drawCrosshairCursor(ctx, x, y, cursorSize);
    return;
  }

  if (cursor.style === 'custom') {
    if (drawCursorImage(cursor.customImagePath)) {
      return;
    }
  }

  if (cursor.style === 'pointer') {
    drawArrowCursor(ctx, x, y, cursorSize, 'rgba(35, 176, 255, 0.95)', 'rgba(255, 255, 255, 0.96)');
    return;
  }

  drawArrowCursor(ctx, x, y, cursorSize, 'rgba(18, 18, 20, 0.96)', 'rgba(255, 255, 255, 0.95)');
}

function drawMotionBlurTrail(
  ctx: Canvas2DContext,
  cursor: CompositionCursorConfig,
  cursorSize: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  intensity: number,
  eventCursorDataUrl?: string,
  eventCursorHotspotX?: number,
  eventCursorHotspotY?: number,
): void {
  if (intensity <= 0) {
    return;
  }

  const travelDistance = Math.hypot(toX - fromX, toY - fromY);
  if (travelDistance < 0.5) {
    return;
  }

  const sampleCount = Math.max(3, Math.min(10, Math.round(3 + intensity * 7)));
  const baseAlpha = 0.28 * intensity;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const t = (sampleIndex + 1) / sampleCount;
    const fade = 1 - t;
    const x = lerp(toX, fromX, t);
    const y = lerp(toY, fromY, t);
    const blurPx = (0.8 + intensity * 2.4) * fade;

    ctx.save();
    ctx.globalAlpha = baseAlpha * fade * fade;
    if (blurPx > 0.05) {
      ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
    }
    drawCursorGlyph(
      ctx,
      x,
      y,
      cursorSize,
      cursor,
      eventCursorDataUrl,
      eventCursorHotspotX,
      eventCursorHotspotY,
    );
    ctx.restore();
  }
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

  if (
    cursor.showMotionBlur &&
    typeof sample.motionBlurFromX === 'number' &&
    typeof sample.motionBlurFromY === 'number' &&
    typeof sample.motionBlurIntensity === 'number'
  ) {
    const blurFromX = contentX + sample.motionBlurFromX * contentWidth;
    const blurFromY = contentY + sample.motionBlurFromY * contentHeight;
    drawMotionBlurTrail(
      ctx,
      cursor,
      cursorSize,
      blurFromX,
      blurFromY,
      cursorX,
      cursorY,
      sample.motionBlurIntensity,
      sample.cursorDataUrl,
      sample.cursorHotspotX,
      sample.cursorHotspotY,
    );
  }

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

  drawCursorGlyph(
    ctx,
    cursorX,
    cursorY,
    cursorSize,
    cursor,
    sample.cursorDataUrl,
    sample.cursorHotspotX,
    sample.cursorHotspotY,
  );
}

export interface RenderCompositionFrameOptions {
  ctx: Canvas2DContext;
  frameWidth: number;
  frameHeight: number;
  t: number;
  config: CompositionConfig;
  source: FrameVideoSource;
  webcamSource?: FrameVideoSource | null;
}

export function renderCompositionFrame({
  ctx,
  frameWidth,
  frameHeight,
  t,
  config,
  source,
  webcamSource,
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
  if (config.webcam?.enabled && webcamSource) {
    drawWebcamLayer(ctx, frameWidth, frameHeight, config.webcam, webcamSource);
  }
  ctx.restore();
}
