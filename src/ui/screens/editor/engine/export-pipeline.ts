import type { AudioSample, VideoSample } from 'mediabunny';

import type { ExportConfig, ExportProgress, Project, RecordedMouseEvent } from '@/types';

import {
  CanvasCoverFrameSource,
  CanvasFrameContext,
  createFrameCanvas,
  MediabunnySampleSource,
} from './adapters';
import { CompositionEngine } from './engine';
import {
  defaultConfig,
  getCutAdjustedDurationMs,
  isInCutRegion,
  mapSourceTimeToCompositionTimeMs,
} from './functions';
import type { CompositionConfig, CompositionLayout, ZoomKeyframe } from './types';

const DEFAULT_LAYOUT_CONFIG = {
  padding: 0.04,
  maxScale: 0.9,
  scaleUp: true,
};

const DEFAULT_VIDEO_STYLE = {
  borderRadius: 24,
  borderWidth: 8,
  borderColor: 'rgba(255, 255, 255, 0.2)',
};

const DEFAULT_WEBCAM_STYLE = {
  anchor: 'bottom-right' as const,
  aspectRatio: 9 / 16,
  heightRatio: 0.28,
  marginPx: 24,
  borderRadius: 3,
  borderWidth: 0,
  borderColor: 'rgba(255, 255, 255, 0.42)',
  opacity: 1,
  shadows: [
    { offsetX: -1, offsetY: 2, blur: 4, color: 'rgba(0, 0, 0, 0.16)' },
    { offsetX: -3, offsetY: 6, blur: 10, color: 'rgba(0, 0, 0, 0.10)' },
    { offsetX: 0, offsetY: 1, blur: 2, color: 'rgba(0, 0, 0, 0.12)' },
  ],
};

const DEFAULT_ZOOM_EPSILON = 0.001;
const MAX_BACKGROUND_SNAPSHOT_SCALE = 2;
const MAX_BACKGROUND_SNAPSHOT_PIXELS = 12_000_000;

export interface EngineCanvasExportResult {
  buffer: ArrayBuffer;
  durationSeconds: number;
  fileSize: number;
}

export interface EngineCanvasExportOptions {
  project: Project;
  config: ExportConfig;
  mouseEvents?: RecordedMouseEvent[];
  onProgress?: (progress: ExportProgress) => void;
  onCancelReady?: (cancel: () => void) => void;
}

type BackgroundLayerCanvas = HTMLCanvasElement | OffscreenCanvas;

function toFileUrl(rawPath: string | undefined): string {
  if (!rawPath) {
    return '';
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function inferWebcamPathFromRawVideo(rawVideoPath: string | undefined): string | undefined {
  if (!rawVideoPath) {
    return undefined;
  }

  const lastDot = rawVideoPath.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === rawVideoPath.length - 1) {
    return undefined;
  }

  return `${rawVideoPath.slice(0, lastDot)}_camera${rawVideoPath.slice(lastDot)}`;
}

function resolveProjectWebcamSourcePath(project: Project): string | undefined {
  const explicitPath = project.webcamOverlay?.sourcePath?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  return inferWebcamPathFromRawVideo(project.rawVideoPath);
}

function resolveWebcamShadows(raw: Project['webcamOverlay']) {
  if (!raw?.shadows || raw.shadows.length === 0) {
    return DEFAULT_WEBCAM_STYLE.shadows;
  }

  const mapped = raw.shadows
    .map((shadow) => {
      const blur = Number.isFinite(shadow.blur) ? Math.max(0, shadow.blur) : 0;
      const offsetX = Number.isFinite(shadow.offsetX) ? shadow.offsetX : 0;
      const offsetY = Number.isFinite(shadow.offsetY) ? shadow.offsetY : 0;
      const color = typeof shadow.color === 'string' ? shadow.color : 'rgba(0, 0, 0, 0.12)';

      return {
        blur,
        offsetX,
        offsetY,
        color,
      };
    })
    .filter((shadow) => shadow.blur > 0 || shadow.offsetX !== 0 || shadow.offsetY !== 0);

  return mapped.length > 0 ? mapped : DEFAULT_WEBCAM_STYLE.shadows;
}

function resolveBackgroundSnapshotDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const basePixels = safeWidth * safeHeight;

  if (basePixels <= 0) {
    return { width: safeWidth, height: safeHeight };
  }

  const maxScaleByPixelBudget = Math.sqrt(MAX_BACKGROUND_SNAPSHOT_PIXELS / basePixels);
  const scale = Math.max(1, Math.min(MAX_BACKGROUND_SNAPSHOT_SCALE, maxScaleByPixelBudget));

  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

function serialiseInlineStyle(style: Record<string, unknown>): string {
  const probe = document.createElement('div');
  const targetStyle = probe.style as CSSStyleDeclaration & Record<string, string>;

  for (const [rawKey, value] of Object.entries(style)) {
    if (rawKey === 'cssText' || value === null || value === undefined) {
      continue;
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
      continue;
    }

    const serialisedValue = String(value);

    if (rawKey.startsWith('--') || rawKey.includes('-')) {
      targetStyle.setProperty(rawKey, serialisedValue);
      continue;
    }

    // Prefer direct property assignment for camelCased React styles.
    targetStyle[rawKey] = serialisedValue;

    // Fallback for keys that don't map cleanly through the camelCase path.
    if (!targetStyle[rawKey]) {
      const kebabKey = rawKey.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
      targetStyle.setProperty(kebabKey, serialisedValue);
    }
  }

  return probe.getAttribute('style') || '';
}

async function loadImage(sourceUrl: string): Promise<HTMLImageElement> {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${sourceUrl}`));
    image.src = sourceUrl;
  });
}

async function drawStyleLayer(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  style: Record<string, unknown> | undefined,
): Promise<void> {
  if (!style) {
    return;
  }

  const colorValue = style.backgroundColor;
  if (typeof colorValue === 'string' && colorValue.trim().length > 0) {
    ctx.fillStyle = colorValue;
    ctx.fillRect(0, 0, width, height);
  }

  const cssDeclarations = serialiseInlineStyle(style);
  if (!cssDeclarations) {
    return;
  }

  const inlineStyle = `width:100%;height:100%;${cssDeclarations}`;
  const escapedStyle = inlineStyle
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" style="${escapedStyle}"></div>
      </foreignObject>
    </svg>
  `;

  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const layerImage = await loadImage(dataUrl);
  ctx.drawImage(layerImage, 0, 0, width, height);
}

function drawImageCover(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  imageWidth: number,
  imageHeight: number,
  targetWidth: number,
  targetHeight: number,
): void {
  if (imageWidth <= 0 || imageHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return;
  }

  const imageAspect = imageWidth / imageHeight;
  const targetAspect = targetWidth / targetHeight;

  let drawWidth = targetWidth;
  let drawHeight = targetHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (imageAspect > targetAspect) {
    drawHeight = targetHeight;
    drawWidth = drawHeight * imageAspect;
    offsetX = (targetWidth - drawWidth) / 2;
  } else {
    drawWidth = targetWidth;
    drawHeight = drawWidth / imageAspect;
    offsetY = (targetHeight - drawHeight) / 2;
  }

  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
}

async function buildStaticBackgroundLayer(
  project: Project,
  width: number,
  height: number,
): Promise<BackgroundLayerCanvas | null> {
  const selectedPattern = project.backgroundPattern;
  const hasPattern = Boolean(selectedPattern && selectedPattern.id !== 'none');
  const backgroundImageUrl = toFileUrl(project.backgroundPath);
  const hasBackgroundImage = backgroundImageUrl.length > 0;

  if (!hasBackgroundImage && !hasPattern) {
    return null;
  }

  // Oversample runtime backgrounds once, then downsample per frame for sharper export output.
  const snapshot = resolveBackgroundSnapshotDimensions(width, height);

  const layerCanvas = createFrameCanvas(snapshot.width, snapshot.height);
  const layerContext = layerCanvas.getContext('2d');
  if (!layerContext) {
    return null;
  }

  const containerStyle: Record<string, unknown> = {
    backgroundColor: project.backgroundColor || '#000000',
    ...(selectedPattern?.containerStyle || {}),
  };

  await drawStyleLayer(layerContext, snapshot.width, snapshot.height, containerStyle);

  if (hasBackgroundImage) {
    try {
      const image = await loadImage(backgroundImageUrl);
      const imageWidth = (image as HTMLImageElement).naturalWidth || image.width;
      const imageHeight = (image as HTMLImageElement).naturalHeight || image.height;

      drawImageCover(layerContext, image, imageWidth, imageHeight, snapshot.width, snapshot.height);
    } catch (error) {
      console.warn('[EngineCanvasExport] Failed to load background image for export:', error);
    }

    return layerCanvas;
  }

  if (hasPattern && selectedPattern?.style) {
    try {
      const patternStyle = selectedPattern.style as Record<string, unknown>;
      await drawStyleLayer(layerContext, snapshot.width, snapshot.height, patternStyle);
    } catch (error) {
      console.warn('[EngineCanvasExport] Failed to render pattern background for export:', error);
    }
  }

  return layerCanvas;
}

function resolveOutputDimensions(config: ExportConfig): { width: number; height: number } {
  switch (config.resolution) {
    case '720p':
      return { width: 1280, height: 720 };
    case '4k':
      return { width: 3840, height: 2160 };
    case 'custom':
      return {
        width: Math.max(2, config.customWidth ?? 1920),
        height: Math.max(2, config.customHeight ?? 1080),
      };
    case '1080p':
    default:
      return { width: 1920, height: 1080 };
  }
}

function calculateFallbackLayout(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): CompositionLayout {
  const availableWidth =
    canvasWidth * (1 - DEFAULT_LAYOUT_CONFIG.padding * 2) * DEFAULT_LAYOUT_CONFIG.maxScale;
  const availableHeight =
    canvasHeight * (1 - DEFAULT_LAYOUT_CONFIG.padding * 2) * DEFAULT_LAYOUT_CONFIG.maxScale;

  const scaleX = availableWidth / videoWidth;
  const scaleY = availableHeight / videoHeight;

  let scale = Math.min(scaleX, scaleY);
  if (!DEFAULT_LAYOUT_CONFIG.scaleUp && scale > 1) {
    scale = 1;
  }

  const width = Math.round(videoWidth * scale);
  const height = Math.round(videoHeight * scale);
  const x = Math.round((canvasWidth - width) / 2);
  const y = Math.round((canvasHeight - height) / 2);

  return { x, y, width, height, scale };
}

async function resolveLayout(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): Promise<CompositionLayout> {
  try {
    return await window.electron.compositor.calculateLayout(
      {
        width: videoWidth,
        height: videoHeight,
      },
      {
        width: canvasWidth,
        height: canvasHeight,
      },
    );
  } catch {
    return calculateFallbackLayout(videoWidth, videoHeight, canvasWidth, canvasHeight);
  }
}

function calculateFallbackWebcamLayout(
  canvasWidth: number,
  canvasHeight: number,
  webcamOverlay: Project['webcamOverlay'],
): CompositionLayout {
  const aspectRatio =
    Number.isFinite(webcamOverlay?.aspectRatio) && (webcamOverlay?.aspectRatio as number) > 0
      ? (webcamOverlay?.aspectRatio as number)
      : DEFAULT_WEBCAM_STYLE.aspectRatio;
  const heightRatio = clamp(
    Number.isFinite(webcamOverlay?.heightRatio)
      ? (webcamOverlay?.heightRatio as number)
      : DEFAULT_WEBCAM_STYLE.heightRatio,
    0.08,
    0.75,
  );
  const marginPx = clamp(
    Math.round(
      Number.isFinite(webcamOverlay?.marginPx)
        ? (webcamOverlay?.marginPx as number)
        : DEFAULT_WEBCAM_STYLE.marginPx,
    ),
    0,
    Math.floor(Math.min(canvasWidth, canvasHeight) / 2),
  );

  let height = Math.max(1, Math.round(canvasHeight * heightRatio));
  let width = Math.max(1, Math.round(height * aspectRatio));

  const maxWidth = Math.max(1, canvasWidth - marginPx * 2);
  const maxHeight = Math.max(1, canvasHeight - marginPx * 2);

  if (width > maxWidth) {
    width = maxWidth;
    height = Math.max(1, Math.round(width / aspectRatio));
  }

  if (height > maxHeight) {
    height = maxHeight;
    width = Math.max(1, Math.round(height * aspectRatio));
  }

  const anchor = webcamOverlay?.anchor ?? DEFAULT_WEBCAM_STYLE.anchor;
  let x = marginPx;
  let y = marginPx;
  switch (anchor) {
    case 'top-right':
      x = canvasWidth - width - marginPx;
      y = marginPx;
      break;
    case 'bottom-left':
      x = marginPx;
      y = canvasHeight - height - marginPx;
      break;
    case 'bottom-right':
      x = canvasWidth - width - marginPx;
      y = canvasHeight - height - marginPx;
      break;
    case 'top-left':
    default:
      x = marginPx;
      y = marginPx;
      break;
  }

  return {
    x: clamp(Math.round(x), 0, Math.max(0, canvasWidth - width)),
    y: clamp(Math.round(y), 0, Math.max(0, canvasHeight - height)),
    width,
    height,
    scale: height / Math.max(1, canvasHeight),
  };
}

async function resolveWebcamLayout(
  canvasWidth: number,
  canvasHeight: number,
  webcamOverlay: Project['webcamOverlay'],
): Promise<CompositionLayout> {
  try {
    return await window.electron.compositor.calculateWebcamLayout(
      {
        width: canvasWidth,
        height: canvasHeight,
      },
      {
        anchor: webcamOverlay?.anchor ?? DEFAULT_WEBCAM_STYLE.anchor,
        aspectRatio:
          Number.isFinite(webcamOverlay?.aspectRatio) && (webcamOverlay?.aspectRatio as number) > 0
            ? (webcamOverlay?.aspectRatio as number)
            : DEFAULT_WEBCAM_STYLE.aspectRatio,
        heightRatio:
          Number.isFinite(webcamOverlay?.heightRatio) && (webcamOverlay?.heightRatio as number) > 0
            ? (webcamOverlay?.heightRatio as number)
            : DEFAULT_WEBCAM_STYLE.heightRatio,
        marginPx: Number.isFinite(webcamOverlay?.marginPx)
          ? Math.max(0, webcamOverlay?.marginPx as number)
          : DEFAULT_WEBCAM_STYLE.marginPx,
      },
    );
  } catch {
    return calculateFallbackWebcamLayout(canvasWidth, canvasHeight, webcamOverlay);
  }
}

interface PreparedWebcamSource {
  frameSource: CanvasCoverFrameSource;
  syncToSeconds: (targetSeconds: number) => Promise<void>;
  dispose: () => void;
}

async function prepareWebcamSource(sourceUrl: string): Promise<PreparedWebcamSource | null> {
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');

  let webcamResponse: Response;
  try {
    webcamResponse = await fetch(sourceUrl);
    if (!webcamResponse.ok && webcamResponse.status !== 0) {
      console.warn('[EngineCanvasExport] Failed to fetch webcam source:', webcamResponse.status);
      return null;
    }
  } catch (error) {
    console.warn('[EngineCanvasExport] Failed to fetch webcam source:', error);
    return null;
  }

  const webcamBlob = await webcamResponse.blob();
  const webcamInput = new Input({
    source: new BlobSource(webcamBlob),
    formats: ALL_FORMATS,
  });

  const webcamVideoTrack = await webcamInput.getPrimaryVideoTrack();
  if (!webcamVideoTrack) {
    console.warn('[EngineCanvasExport] Webcam source has no video track.');
    webcamInput.dispose();
    return null;
  }

  const canvasSink = new CanvasSink(webcamVideoTrack);
  const frameSource = new CanvasCoverFrameSource();

  // Use sequential iterator instead of random-access getCanvas().
  // canvases() pre-decodes frames ahead and decodes each packet at most once,
  // whereas getCanvas() re-seeks from the nearest keyframe every call.
  const frameIterator = canvasSink.canvases();
  let currentCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  let nextFrame = await frameIterator.next();

  const syncToSeconds = async (targetSeconds: number): Promise<void> => {
    if (!Number.isFinite(targetSeconds)) {
      frameSource.setCanvas(null);
      return;
    }

    const target = Math.max(0, targetSeconds);

    // Advance the iterator forward until we reach or pass the target timestamp.
    // Since export timestamps are monotonically increasing, each frame is decoded
    // at most once across the entire export — O(n) total.
    while (!nextFrame.done && nextFrame.value.timestamp <= target) {
      currentCanvas = nextFrame.value.canvas;
      nextFrame = await frameIterator.next();
    }

    frameSource.setCanvas(currentCanvas);
  };

  return {
    frameSource,
    syncToSeconds,
    dispose: () => {
      frameSource.setCanvas(null);
      void frameIterator.return(undefined);
      webcamInput.dispose();
    },
  };
}

function clampNormalised(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}

function mapLegacyZoomConfigToZoomKeyframes(
  zoomConfig: Project['zoomConfig'] | undefined,
  durationMs: number,
  hasZoomRegions: boolean,
): ZoomKeyframe[] {
  if (hasZoomRegions || !zoomConfig || durationMs <= 0) {
    return [];
  }

  const level = Number.isFinite(zoomConfig.level) ? Math.max(0.1, zoomConfig.level) : 1;
  if (Math.abs(level - 1) <= DEFAULT_ZOOM_EPSILON) {
    return [];
  }

  return [
    {
      startTime: 0,
      endTime: durationMs / 1000,
      focalPoint: {
        x: clampNormalised(zoomConfig.focalX),
        y: clampNormalised(zoomConfig.focalY),
      },
      multiplier: level,
      easeIn: 0,
      easeOut: 0,
    },
  ];
}

function buildCompositionConfig(
  project: Project,
  layout: CompositionLayout,
  webcamLayout: CompositionLayout | null,
  webcamSourcePath: string | undefined,
  sourceDurationMs: number,
  preserveUnderlyingBackground: boolean,
  mouseEvents: RecordedMouseEvent[],
): CompositionConfig {
  const hasZoomRegions = project.zoomRegions.length > 0;
  const legacyZoomFallback = mapLegacyZoomConfigToZoomKeyframes(
    project.zoomConfig,
    sourceDurationMs,
    hasZoomRegions,
  );
  const sourceWidth = project.videoDimensions?.width ?? 0;
  const sourceHeight = project.videoDimensions?.height ?? 0;
  const rawCursor = project.cursorConfig;
  const rawWebcam = project.webcamOverlay;
  const webcamEnabled = Boolean(rawWebcam?.enabled && webcamSourcePath);
  const webcamBorderRadius = Number.isFinite(rawWebcam?.borderRadiusPx)
    ? Math.max(0, rawWebcam?.borderRadiusPx ?? DEFAULT_WEBCAM_STYLE.borderRadius)
    : DEFAULT_WEBCAM_STYLE.borderRadius;
  const webcamBorderWidth = Number.isFinite(rawWebcam?.borderWidthPx)
    ? Math.max(0, rawWebcam?.borderWidthPx ?? DEFAULT_WEBCAM_STYLE.borderWidth)
    : DEFAULT_WEBCAM_STYLE.borderWidth;
  const webcamOpacity = clamp(
    Number.isFinite(rawWebcam?.opacity)
      ? (rawWebcam?.opacity as number)
      : DEFAULT_WEBCAM_STYLE.opacity,
    0,
    1,
  );

  return {
    ...defaultConfig,
    background: {
      enabled: true,
      type: 'color',
      // Keep canvas content when we pre-compose a background layer (preview-like behavior).
      color: preserveUnderlyingBackground ? 'transparent' : project.backgroundColor || '#000000',
    },
    video: {
      scale: layout.scale,
      borderRadius: DEFAULT_VIDEO_STYLE.borderRadius,
      border: {
        width: DEFAULT_VIDEO_STYLE.borderWidth,
        color: DEFAULT_VIDEO_STYLE.borderColor,
      },
    },
    webcam: webcamEnabled
      ? {
          enabled: true,
          sourcePath: webcamSourcePath,
          anchor: rawWebcam?.anchor ?? DEFAULT_WEBCAM_STYLE.anchor,
          aspectRatio:
            Number.isFinite(rawWebcam?.aspectRatio) && (rawWebcam?.aspectRatio as number) > 0
              ? (rawWebcam?.aspectRatio as number)
              : DEFAULT_WEBCAM_STYLE.aspectRatio,
          heightRatio: clamp(
            Number.isFinite(rawWebcam?.heightRatio)
              ? (rawWebcam?.heightRatio as number)
              : DEFAULT_WEBCAM_STYLE.heightRatio,
            0.08,
            0.75,
          ),
          marginPx: Number.isFinite(rawWebcam?.marginPx)
            ? Math.max(0, rawWebcam?.marginPx as number)
            : DEFAULT_WEBCAM_STYLE.marginPx,
          borderRadius: webcamBorderRadius,
          opacity: webcamOpacity,
          border: {
            width: webcamBorderWidth,
            color: rawWebcam?.borderColor ?? DEFAULT_WEBCAM_STYLE.borderColor,
          },
          shadows: resolveWebcamShadows(rawWebcam),
          layout: webcamLayout ?? undefined,
        }
      : undefined,
    layout,
    zooms: legacyZoomFallback,
    zoomRegions: project.zoomRegions.map((region) => ({
      id: region.id,
      startMs: region.startMs,
      endMs: region.endMs,
      zoomLevel: region.zoomLevel,
      focalX: region.focalX,
      focalY: region.focalY,
      easeDurationMs: region.easeDurationMs,
      focalKeyframes: region.focalKeyframes,
    })),
    cuts: project.cuts.map((cut) => ({
      id: cut.id,
      startMs: cut.startMs,
      endMs: cut.endMs,
    })),
    cursor: {
      enabled: true,
      size: Number.isFinite(rawCursor?.size) ? Math.max(0.2, rawCursor.size) : 1,
      style: rawCursor?.style ?? 'default',
      customImagePath: rawCursor?.customImagePath,
      showClickAnimations: rawCursor?.showClickAnimations ?? true,
      clickAnimationScale: Number.isFinite(rawCursor?.clickAnimationScale)
        ? Math.max(0.5, rawCursor.clickAnimationScale)
        : 1.2,
      clickDisplayDuration: Number.isFinite(rawCursor?.clickDisplayDuration)
        ? Math.max(80, rawCursor.clickDisplayDuration)
        : 500,
      showMotionBlur: rawCursor?.showMotionBlur ?? true,
      motionBlurStrength: Number.isFinite(rawCursor?.motionBlurStrength)
        ? Math.max(0, Math.min(2.5, rawCursor.motionBlurStrength))
        : 0.7,
      sourceWidth,
      sourceHeight,
      events: [...mouseEvents]
        .filter((event) => Number.isFinite(event.timestampMs))
        .sort((a, b) => a.timestampMs - b.timestampMs)
        .map((event) => ({
          timestampMs: event.timestampMs,
          x: event.x,
          y: event.y,
          normalizedX: event.normalizedX,
          normalizedY: event.normalizedY,
          cursorDataUrl: event.cursorDataUrl,
          cursorHotspotX: event.cursorHotspotX,
          cursorHotspotY: event.cursorHotspotY,
          cursorHandleHex: event.cursorHandleHex,
          eventType: event.eventType,
          button: event.button,
        })),
    },
  };
}

function resolveVideoBitrate(config: ExportConfig): number {
  switch (config.quality) {
    case 'low':
      return 4_000_000;
    case 'medium':
      return 8_000_000;
    case 'lossless':
      return 20_000_000;
    case 'high':
    default:
      return 12_000_000;
  }
}

function createProgressSnapshot(
  fraction: number,
  totalFrames: number,
  startedAtMs: number,
): ExportProgress {
  const clamped = Math.max(0, Math.min(1, fraction));
  const currentFrame = Math.min(totalFrames, Math.round(totalFrames * clamped));
  const elapsedSeconds = Math.max(0.001, (performance.now() - startedAtMs) / 1000);
  const fps = currentFrame / elapsedSeconds;
  const eta = clamped > 0 ? Math.max(0, Math.round((elapsedSeconds * (1 - clamped)) / clamped)) : 0;
  const percent = Math.round(clamped * 100);

  return {
    percent,
    currentFrame,
    totalFrames,
    fps,
    eta,
    stage: 'export',
    stagePercent: percent,
  };
}

export async function runEngineCanvasExport({
  project,
  config,
  mouseEvents = [],
  onProgress,
  onCancelReady,
}: EngineCanvasExportOptions): Promise<EngineCanvasExportResult> {
  const { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } =
    await import('mediabunny');

  const sourceUrl = toFileUrl(project.rawVideoPath);
  if (!sourceUrl) {
    throw new Error('Source video path is missing');
  }

  const webcamSourcePath = resolveProjectWebcamSourcePath(project);
  const webcamSourceUrl = toFileUrl(webcamSourcePath);

  let cancelRequested = false;
  let cancelConversion: (() => void) | null = null;
  let preparedWebcamSource: PreparedWebcamSource | null = null;

  onCancelReady?.(() => {
    cancelRequested = true;
    cancelConversion?.();
  });

  const response = await fetch(sourceUrl);
  if (!response.ok && response.status !== 0) {
    throw new Error(`Failed to read source video: ${response.status}`);
  }

  const sourceBlob = await response.blob();
  const input = new Input({
    source: new BlobSource(sourceBlob),
    formats: ALL_FORMATS,
  });

  try {
    const inputDurationMs = Math.max(0, Math.round((await input.computeDuration()) * 1000));
    const primaryVideoTrack = await input.getPrimaryVideoTrack();
    const sourceVideoWidth =
      project.videoDimensions?.width ||
      primaryVideoTrack?.displayWidth ||
      config.customWidth ||
      1920;
    const sourceVideoHeight =
      project.videoDimensions?.height ||
      primaryVideoTrack?.displayHeight ||
      config.customHeight ||
      1080;

    const sourceDurationMs = Math.max(0, project.timeline.duration || inputDurationMs);
    const compositionDurationMs = getCutAdjustedDurationMs(sourceDurationMs, project.cuts);
    const outputDimensions = resolveOutputDimensions(config);
    const layout = await resolveLayout(
      sourceVideoWidth,
      sourceVideoHeight,
      outputDimensions.width,
      outputDimensions.height,
    );

    const webcamLayout =
      project.webcamOverlay?.enabled && webcamSourcePath
        ? await resolveWebcamLayout(
            outputDimensions.width,
            outputDimensions.height,
            project.webcamOverlay,
          )
        : null;

    if (project.webcamOverlay?.enabled && webcamSourceUrl) {
      preparedWebcamSource = await prepareWebcamSource(webcamSourceUrl);
      if (!preparedWebcamSource) {
        console.warn(
          '[EngineCanvasExport] Webcam overlay enabled but webcam source could not be prepared.',
        );
      }
    }

    const backgroundLayer = await buildStaticBackgroundLayer(
      project,
      outputDimensions.width,
      outputDimensions.height,
    );

    const compositionConfig = buildCompositionConfig(
      project,
      layout,
      webcamLayout,
      webcamSourcePath,
      sourceDurationMs,
      backgroundLayer !== null,
      mouseEvents,
    );
    const engine = new CompositionEngine(compositionConfig);
    engine.setDuration(compositionDurationMs / 1000);

    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    });

    let frameContext: CanvasFrameContext | null = null;

    const ensureFrameContext = (): CanvasFrameContext => {
      if (frameContext) {
        return frameContext;
      }

      const frameCanvas = createFrameCanvas(outputDimensions.width, outputDimensions.height);
      frameContext = new CanvasFrameContext(frameCanvas);
      return frameContext;
    };

    const totalFrames = Math.max(1, Math.ceil((compositionDurationMs / 1000) * config.fps));
    const startedAtMs = performance.now();

    const conversion = await Conversion.init({
      input,
      output,
      video: {
        frameRate: config.fps,
        width: outputDimensions.width,
        height: outputDimensions.height,
        fit: 'fill',
        codec: 'avc',
        bitrate: resolveVideoBitrate(config),
        forceTranscode: true,
        processedWidth: outputDimensions.width,
        processedHeight: outputDimensions.height,
        process: async (sample: VideoSample) => {
          if (cancelRequested) {
            return null;
          }

          const sourceTimeMs = sample.timestamp * 1000;
          if (isInCutRegion(sourceTimeMs, compositionConfig.cuts)) {
            return null;
          }

          const compositionTimeSeconds =
            mapSourceTimeToCompositionTimeMs(sourceTimeMs, compositionConfig.cuts) / 1000;

          sample.setTimestamp(compositionTimeSeconds);

          const context = ensureFrameContext();
          if (backgroundLayer) {
            const frameCtx = context.get2DContext();
            frameCtx.clearRect(0, 0, outputDimensions.width, outputDimensions.height);
            frameCtx.drawImage(
              backgroundLayer,
              0,
              0,
              outputDimensions.width,
              outputDimensions.height,
            );
          }

          if (preparedWebcamSource) {
            await preparedWebcamSource.syncToSeconds(sourceTimeMs / 1000);
          }

          engine.renderFrameAt(
            compositionTimeSeconds,
            context,
            new MediabunnySampleSource(sample),
            preparedWebcamSource?.frameSource ?? null,
          );

          return context.getCanvas();
        },
      },
      audio: {
        process: (sample: AudioSample) => {
          if (cancelRequested) {
            return null;
          }

          const sourceTimeMs = sample.timestamp * 1000;
          if (isInCutRegion(sourceTimeMs, compositionConfig.cuts)) {
            return null;
          }

          const compositionTimeSeconds =
            mapSourceTimeToCompositionTimeMs(sourceTimeMs, compositionConfig.cuts) / 1000;

          sample.setTimestamp(compositionTimeSeconds);
          return sample;
        },
      },
    });

    cancelConversion = () => {
      void conversion.cancel();
    };

    if (cancelRequested) {
      void conversion.cancel();
      throw new Error('Export cancelled');
    }

    conversion.onProgress = (fraction) => {
      onProgress?.(createProgressSnapshot(fraction, totalFrames, startedAtMs));
    };

    await conversion.execute();

    const buffer = target.buffer;
    if (!buffer) {
      throw new Error('Encoded output buffer is empty');
    }

    onProgress?.(createProgressSnapshot(1, totalFrames, startedAtMs));

    return {
      buffer,
      durationSeconds: compositionDurationMs / 1000,
      fileSize: buffer.byteLength,
    };
  } catch (error) {
    if (cancelRequested) {
      throw new Error('Export cancelled');
    }
    throw error;
  } finally {
    preparedWebcamSource?.dispose();
    input.dispose();
  }
}
