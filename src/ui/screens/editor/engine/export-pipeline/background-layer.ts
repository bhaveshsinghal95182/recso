import type { Project } from '@/types';

import { createFrameCanvas } from '../adapters';
import { MAX_BACKGROUND_SNAPSHOT_PIXELS, MAX_BACKGROUND_SNAPSHOT_SCALE } from './defaults';
import { toFileUrl } from './source-paths';
import type { BackgroundLayerCanvas } from './types';

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

    // Fallback for keys that do not map cleanly through the camelCase path.
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

export async function buildStaticBackgroundLayer(
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
  const layerContext = layerCanvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
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
