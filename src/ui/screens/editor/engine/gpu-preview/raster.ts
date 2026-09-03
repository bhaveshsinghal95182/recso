/**
 * Turning the editor's Canvas2D drawing into pixels the engine can upload.
 *
 * The engine takes backgrounds and cursors as RGBA buffers rather than
 * reimplementing the generators in HLSL. That is not a shortcut: both are
 * static -- a background for a whole export, a cursor until the style changes
 * -- so there is nothing to gain from generating them per frame, and a shader
 * reimplementation would be a second thing that has to match these pixel for
 * pixel forever.
 *
 * Drawing them with the same functions the compositor uses means they cannot
 * drift by construction.
 */

import { drawArrowCursor, drawBackground, drawCrosshairCursor } from '../functions';
import type { BackgroundConfig, CompositionCursorConfig } from '../types';

/** What the engine's `setBackground`/`setCursorImage` want. */
export interface RgbaBitmap {
  width: number;
  height: number;
  /** Tightly packed RGBA8. An ArrayBuffer, because a typed array is
   *  structured-cloned into something the main process cannot hand to the
   *  addon. */
  pixels: ArrayBuffer;
  hotspotX?: number;
  hotspotY?: number;
}

function createContext(width: number, height: number): OffscreenCanvasRenderingContext2D | null {
  if (width <= 0 || height <= 0) {
    return null;
  }

  const canvas = new OffscreenCanvas(width, height);
  // `willReadFrequently` because every one of these is drawn once and then read
  // straight back, which is the pattern the flag exists for.
  return canvas.getContext('2d', { willReadFrequently: true });
}

function readBack(ctx: OffscreenCanvasRenderingContext2D): RgbaBitmap {
  const { width, height } = ctx.canvas;
  const image = ctx.getImageData(0, 0, width, height);
  // `.buffer` is the underlying ArrayBuffer of the Uint8ClampedArray, and
  // `getImageData` always hands back a view over a whole one.
  return { width, height, pixels: image.data.buffer as ArrayBuffer };
}

/**
 * Rasterise a background at canvas size.
 *
 * Returns `null` for a background the engine can express as a flat colour --
 * a clear costs nothing and an image costs an upload plus a full-canvas quad,
 * so it is worth telling them apart.
 */
export function rasteriseBackground(
  background: BackgroundConfig,
  width: number,
  height: number,
): RgbaBitmap | null {
  if (!background.enabled || background.type === 'color') {
    return null;
  }

  const ctx = createContext(width, height);
  if (!ctx) {
    return null;
  }

  drawBackground(ctx, width, height, background);
  return readBack(ctx);
}

/** The flat colour behind everything, as the engine's 0..1 channels. */
export function backgroundColour(background: BackgroundConfig): {
  r: number;
  g: number;
  b: number;
  a: number;
} {
  const opaqueBlack = { r: 0, g: 0, b: 0, a: 1 };
  if (!background.enabled) {
    return opaqueBlack;
  }

  const css = background.type === 'color' ? background.color : background.backgroundColor;
  return parseCssColour(css) ?? opaqueBlack;
}

/**
 * `#rgb`, `#rrggbb`, `#rrggbbaa` and `rgb()`/`rgba()` into 0..1 channels.
 *
 * Parsed here rather than in Rust: the shader wants floats, and the colour
 * arrives from a picker that already knows what it means. Anything unparseable
 * returns `null` so the caller can fall back rather than silently rendering
 * black.
 */
export function parseCssColour(
  css: string | undefined,
): { r: number; g: number; b: number; a: number } | null {
  if (!css) {
    return null;
  }

  const value = css.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex) {
    const digits = hex[1];
    const expand = (part: string) => parseInt(part.length === 1 ? part + part : part, 16) / 255;

    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits[0]),
        g: expand(digits[1]),
        b: expand(digits[2]),
        a: digits.length === 4 ? expand(digits[3]) : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: expand(digits.slice(0, 2)),
        g: expand(digits.slice(2, 4)),
        b: expand(digits.slice(4, 6)),
        a: digits.length === 8 ? expand(digits.slice(6, 8)) : 1,
      };
    }
    return null;
  }

  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) {
      return null;
    }
    const channel = (part: string) =>
      part.endsWith('%') ? Number(part.slice(0, -1)) / 100 : Number(part) / 255;
    const alpha =
      parts[3] === undefined
        ? 1
        : Number(parts[3].replace('%', '')) / (parts[3].endsWith('%') ? 100 : 1);
    const [r, g, b] = [channel(parts[0]), channel(parts[1]), channel(parts[2])];
    if (![r, g, b, alpha].every(Number.isFinite)) {
      return null;
    }
    return { r, g, b, a: alpha };
  }

  return null;
}

/** How big a rasterised glyph is drawn, before the engine scales it. */
const GLYPH_SIZE_PX = 64;

/**
 * Rasterise the cursor the config asks for.
 *
 * The engine draws one bitmap for the whole track, so a built-in glyph has to
 * become pixels somewhere. Doing it with the compositor's own drawing functions
 * keeps the two paths' pointers identical.
 *
 * A custom image is loaded instead, and its hotspot is the caller's. Returns
 * `null` when there is nothing to draw.
 */
export async function rasteriseCursor(
  cursor: CompositionCursorConfig | undefined,
): Promise<RgbaBitmap | null> {
  if (!cursor?.enabled) {
    return null;
  }

  if (cursor.style === 'custom' && cursor.customImagePath) {
    return await loadImageBitmap(cursor.customImagePath);
  }

  if (cursor.style === 'crosshair') {
    // Drawn around its point, so the sprite is symmetric and the hotspot is the
    // middle. The arms reach 0.75 of the size either way; a little padding
    // stops the stroke clipping.
    const extent = Math.ceil(GLYPH_SIZE_PX * 1.75);
    const ctx = createContext(extent, extent);
    if (!ctx) return null;
    drawCrosshairCursor(ctx, extent / 2, extent / 2, GLYPH_SIZE_PX);
    return { ...readBack(ctx), hotspotX: extent / 2, hotspotY: extent / 2 };
  }

  // The arrow is drawn from its point, down and to the right, so the sprite's
  // hotspot is its top-left corner. The path reaches 0.72 across and 2.28 down;
  // the stroke adds a little on each side.
  const stroke = Math.max(1, GLYPH_SIZE_PX * 0.09);
  const width = Math.ceil(GLYPH_SIZE_PX * 0.72 + stroke * 2);
  const height = Math.ceil(GLYPH_SIZE_PX * 2.28 + stroke * 2);
  const ctx = createContext(width, height);
  if (!ctx) return null;

  drawArrowCursor(ctx, stroke, stroke, GLYPH_SIZE_PX, '#ffffff', 'rgba(0, 0, 0, 0.85)');
  return { ...readBack(ctx), hotspotX: stroke, hotspotY: stroke };
}

/** Load an image path into RGBA, for a custom cursor or a background image. */
export async function loadImageBitmap(src: string): Promise<RgbaBitmap | null> {
  try {
    const response = await fetch(src);
    if (!response.ok && response.status !== 0) {
      return null;
    }
    const bitmap = await createImageBitmap(await response.blob());
    const ctx = createContext(bitmap.width, bitmap.height);
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return readBack(ctx);
  } catch {
    // A missing cursor image is not worth failing a preview over; the engine
    // simply draws no pointer.
    return null;
  }
}
