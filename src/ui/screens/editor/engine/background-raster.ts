/**
 * The canvas background, as pixels.
 *
 * The background a project describes is CSS -- the presets in
 * `shared/patterns.ts` are `background` shorthands with layered gradients,
 * because that is what they were authored as and what the picker previews. CSS
 * is not something a Canvas2D context or an HLSL shader can be handed, so
 * somewhere it has to become a bitmap, and this is that somewhere.
 *
 * The trick is an SVG `foreignObject` wrapping a `<div>` carrying the style:
 * Chromium lays it out and paints it with the same code that paints the picker,
 * then it is an image like any other. That matters more than it sounds --
 * reimplementing `conic-gradient` in a canvas or a shader would be a second
 * thing that has to match the first forever, and the whole reason the presets
 * look right in the panel is that the browser drew them.
 *
 * Every path that needs a background funnels through here: the canvas
 * exporter's pre-composed layer, and the texture the engine uploads.
 */

import type { BackgroundMode, Project } from '@/types';

type AnyContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Which of the three kinds of background a project has.
 *
 * `backgroundMode` is authoritative when it is set. The fallbacks below are for
 * projects saved before it existed, where the mode was implied by whichever of
 * the other fields was filled in.
 */
export function resolveBackgroundMode(project: Project | null): BackgroundMode {
  if (project?.backgroundMode === 'color') return 'color';
  if (project?.backgroundMode === 'pattern') return 'pattern';
  if (project?.backgroundMode === 'image') return 'image';

  if (project?.backgroundPath) {
    return 'image';
  }

  const hasPattern = Boolean(project?.backgroundPattern && project.backgroundPattern.id !== 'none');
  if (hasPattern) {
    return 'pattern';
  }

  return 'color';
}

/**
 * A React style object as the `style` attribute Chromium would parse.
 *
 * Round-tripped through a real `CSSStyleDeclaration` rather than string-joined:
 * that is what turns `backgroundSize` into `background-size`, drops anything
 * the browser would refuse anyway, and expands shorthands exactly as the live
 * preview does.
 */
export function serialiseInlineStyle(style: Record<string, unknown>): string {
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

export async function loadImage(sourceUrl: string): Promise<HTMLImageElement> {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${sourceUrl}`));
    image.src = sourceUrl;
  });
}

/**
 * Paint one CSS style object across the whole context.
 *
 * The flat `backgroundColor` is filled first and separately, rather than left
 * to the `foreignObject`. That div paints onto transparency, so a pattern whose
 * own layers do not reach every corner would leave the surface showing through
 * -- which for the engine is whatever happened to be in that texture before.
 */
export async function drawStyleLayer(
  ctx: AnyContext,
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

/** `object-fit: cover`, by hand, since a canvas has no such thing. */
export function drawImageCover(
  ctx: AnyContext,
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

/**
 * What a project's background is made of: the flat colour, then whatever sits
 * on top of it.
 *
 * Described rather than drawn, because the two consumers size their own
 * surface -- the Canvas2D preview oversamples and downscales per frame, the
 * engine wants exactly canvas size and nothing else.
 */
export interface CanvasBackgroundLayers {
  /** Always present: the colour behind everything. */
  container: Record<string, unknown>;
  /** The preset's own CSS, in pattern mode. */
  pattern?: Record<string, unknown>;
  /** A `file://` URL, in image mode. */
  imageUrl?: string;
}

/**
 * What to paint for a project's canvas background, or `null` for nothing.
 *
 * `null` is full-bleed: the recording fills the canvas, so there is no
 * background to speak of and drawing one would only be overdrawn.
 */
export function resolveCanvasBackgroundLayers(
  project: Project | null,
  imageUrl: string,
): CanvasBackgroundLayers | null {
  if (project?.canvasBackgroundEnabled === false) {
    return null;
  }

  const mode = resolveBackgroundMode(project);
  const pattern = mode === 'pattern' ? project?.backgroundPattern : null;
  const container: Record<string, unknown> = {
    backgroundColor: project?.backgroundColor || '#000000',
    ...(pattern?.containerStyle ?? {}),
  };

  if (mode === 'image' && imageUrl) {
    return { container, imageUrl };
  }

  if (pattern && pattern.id !== 'none' && pattern.style) {
    return { container, pattern: pattern.style as Record<string, unknown> };
  }

  return { container };
}

/**
 * Draw a resolved background onto a context, whatever kind it is.
 *
 * A background image that will not load costs the image and keeps the colour,
 * rather than failing the frame -- the export or the preview is still the video
 * the user asked for, on a plain background instead of the picture they chose.
 */
export async function paintCanvasBackground(
  ctx: AnyContext,
  layers: CanvasBackgroundLayers,
  width: number,
  height: number,
): Promise<void> {
  await drawStyleLayer(ctx, width, height, layers.container);

  if (layers.imageUrl) {
    try {
      const image = await loadImage(layers.imageUrl);
      const imageWidth = image.naturalWidth || image.width;
      const imageHeight = image.naturalHeight || image.height;
      drawImageCover(ctx, image, imageWidth, imageHeight, width, height);
    } catch (error) {
      console.warn('[background] the background image did not load:', error);
    }
    return;
  }

  if (layers.pattern) {
    try {
      await drawStyleLayer(ctx, width, height, layers.pattern);
    } catch (error) {
      // The container colour is already down, so what is left is the pattern's
      // base rather than nothing. Costing the preview or the export over a
      // decoration that would not paint is the worse trade.
      console.warn('[background] the pattern did not rasterise:', error);
    }
  }
}
