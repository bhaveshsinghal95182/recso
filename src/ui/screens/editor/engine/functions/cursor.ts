import type {
  Canvas2DContext,
  CompositionCursorConfig,
  CompositionCursorEvent,
  VideoLayout,
} from '../types';
import { clampUnit, lerp } from './common';

const DEFAULT_CURSOR_SIZE_PX = 22;
const DEFAULT_FIXED_MOTION_BLUR_STRENGTH = 0.7;
const MOTION_BLUR_TRAIL_MS = 90;
const MAX_MOTION_BLUR_EVENT_GAP_MS = 260;
const MOTION_BLUR_SPEED_SCALE = 220;
const KNOWN_IBEAM_CURSOR_HANDLES = new Set<number>([0x10005, 0x7f01]);
const cursorImageCache = new Map<string, HTMLImageElement | null>();
const cursorImageLoading = new Set<string>();

interface CursorSample {
  normalizedX: number;
  normalizedY: number;
  cursorOverrideImagePath?: string;
  cursorDataUrl?: string;
  cursorHotspotX?: number;
  cursorHotspotY?: number;
  cursorHandleHex?: string;
  motionBlurFromX?: number;
  motionBlurFromY?: number;
  motionBlurIntensity?: number;
}

function parseCursorHandleHex(cursorHandleHex: string | undefined): number | null {
  if (!cursorHandleHex) {
    return null;
  }

  const raw = cursorHandleHex.trim();
  if (raw.length === 0) {
    return null;
  }

  if (/^0x[0-9a-f]+$/i.test(raw)) {
    const value = Number.parseInt(raw.slice(2), 16);
    return Number.isFinite(value) ? value : null;
  }

  if (/^[0-9]+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  }

  return null;
}

function isIBeamCursorHandle(cursorHandleHex: string | undefined): boolean {
  const value = parseCursorHandleHex(cursorHandleHex);
  if (value === null) {
    return false;
  }

  return KNOWN_IBEAM_CURSOR_HANDLES.has(value);
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

  if (event.visible === false) {
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

function resolveCursorOverrideImagePath(
  cursor: CompositionCursorConfig,
  timestampMs: number,
): string | undefined {
  const overrides = cursor.cursorRegionOverrides;
  if (!overrides || overrides.length === 0) {
    return undefined;
  }

  for (const cursorOverride of overrides) {
    if (timestampMs >= cursorOverride.startMs && timestampMs < cursorOverride.endMs) {
      return cursorOverride.imagePath;
    }
  }

  const trailingOverride = overrides[overrides.length - 1];
  if (trailingOverride && timestampMs === trailingOverride.endMs) {
    return trailingOverride.imagePath;
  }

  return undefined;
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
  const resolvedPosition = beforeEvent ? beforePosition : afterPosition;
  const sourceEvent = beforeEvent ? beforeEvent : afterEvent;
  if (!resolvedPosition) {
    return null;
  }

  let motionBlurFromX: number | undefined;
  let motionBlurFromY: number | undefined;
  let motionBlurIntensity: number | undefined;

  if (beforeEvent && previousEvent && beforePosition && previousPosition) {
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
      const strength = DEFAULT_FIXED_MOTION_BLUR_STRENGTH;
      const intensity = clampUnit(speedFactor * ageFactor * strength);

      if (intensity > 0.015) {
        motionBlurFromX = previousPosition.x;
        motionBlurFromY = previousPosition.y;
        motionBlurIntensity = intensity;
      }
    }
  }

  return {
    normalizedX: clampUnit(resolvedPosition.x),
    normalizedY: clampUnit(resolvedPosition.y),
    cursorOverrideImagePath: resolveCursorOverrideImagePath(cursor, timestampMs),
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
    cursorHandleHex:
      sourceEvent && typeof sourceEvent.cursorHandleHex === 'string'
        ? sourceEvent.cursorHandleHex
        : undefined,
    motionBlurFromX,
    motionBlurFromY,
    motionBlurIntensity,
  };
}

export function drawArrowCursor(
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

export function drawCrosshairCursor(
  ctx: Canvas2DContext,
  x: number,
  y: number,
  size: number,
): void {
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

export function drawIBeamCursor(ctx: Canvas2DContext, x: number, y: number, size: number): void {
  const stemHeight = size * 1.9;
  const stemWidth = Math.max(2, size * 0.16);
  const capWidth = Math.max(stemWidth * 2.6, size * 0.64);
  const capHeight = Math.max(1, size * 0.1);
  const topY = y - stemHeight * 0.5;
  const bottomY = topY + stemHeight - capHeight;
  const stemX = x - stemWidth / 2;
  const capX = x - capWidth / 2;

  ctx.save();

  // Draw a light halo first so the text cursor remains readable on dark backgrounds.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.fillRect(capX - 1, topY - 1, capWidth + 2, capHeight + 2);
  ctx.fillRect(stemX - 1, topY - 1, stemWidth + 2, stemHeight + 2);
  ctx.fillRect(capX - 1, bottomY - 1, capWidth + 2, capHeight + 2);

  ctx.fillStyle = 'rgba(14, 14, 16, 0.98)';
  ctx.fillRect(capX, topY, capWidth, capHeight);
  ctx.fillRect(stemX, topY, stemWidth, stemHeight);
  ctx.fillRect(capX, bottomY, capWidth, capHeight);

  ctx.restore();
}

function drawCursorGlyph(
  ctx: Canvas2DContext,
  x: number,
  y: number,
  cursorSize: number,
  cursor: CompositionCursorConfig,
  overrideCursorImagePath?: string,
  eventCursorDataUrl?: string,
  eventCursorHotspotX?: number,
  eventCursorHotspotY?: number,
  eventCursorHandleHex?: string,
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

  if (drawCursorImage(overrideCursorImagePath)) {
    return;
  }

  if (isIBeamCursorHandle(eventCursorHandleHex)) {
    drawIBeamCursor(ctx, x, y, cursorSize);
    return;
  }

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
  overrideCursorImagePath?: string,
  eventCursorDataUrl?: string,
  eventCursorHotspotX?: number,
  eventCursorHotspotY?: number,
  eventCursorHandleHex?: string,
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
      overrideCursorImagePath,
      eventCursorDataUrl,
      eventCursorHotspotX,
      eventCursorHotspotY,
      eventCursorHandleHex,
    );
    ctx.restore();
  }
}

export function drawCursorLayer(
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
      sample.cursorOverrideImagePath,
      sample.cursorDataUrl,
      sample.cursorHotspotX,
      sample.cursorHotspotY,
      sample.cursorHandleHex,
    );
  }

  drawCursorGlyph(
    ctx,
    cursorX,
    cursorY,
    cursorSize,
    cursor,
    sample.cursorOverrideImagePath,
    sample.cursorDataUrl,
    sample.cursorHotspotX,
    sample.cursorHotspotY,
    sample.cursorHandleHex,
  );
}
