import type { AudioSample, VideoSample } from 'mediabunny';

import type { ExportConfig, ExportProgress, Project, RecordedMouseEvent } from '@/types';

import { CanvasFrameContext, createFrameCanvas, MediabunnySampleSource } from './adapters';
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

  let cancelRequested = false;
  let cancelConversion: (() => void) | null = null;

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

    const backgroundLayer = await buildStaticBackgroundLayer(
      project,
      outputDimensions.width,
      outputDimensions.height,
    );

    const compositionConfig = buildCompositionConfig(
      project,
      layout,
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
        process: (sample: VideoSample) => {
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

          engine.renderFrameAt(compositionTimeSeconds, context, new MediabunnySampleSource(sample));

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
    input.dispose();
  }
}
