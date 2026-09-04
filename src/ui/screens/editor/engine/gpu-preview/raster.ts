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

import {
  drawArrowCursor,
  drawBackground,
  drawCrosshairCursor,
  drawIBeamCursor,
  isIBeamCursorHandle,
} from '../functions';
import type {
  BackgroundConfig,
  CompositionCursorConfig,
  CompositionCursorEvent,
  CompositionCursorRegionOverride,
} from '../types';

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

/**
 * The distinct pointer bitmaps a recording used, plus the id for each event.
 *
 * Four things can decide the pointer's shape at a given moment, and they are
 * tried in the order `drawCursorGlyph` tries them, so the two paths agree:
 *
 *   1. a region override, which swaps the image for a span of the timeline
 *   2. the I-beam glyph, when the recorded cursor handle is a known text caret
 *   3. the bitmap the recorder captured with the event
 *   4. the default pointer, which the engine holds separately
 *
 * All four collapse to one mechanism here: an index into a table the engine
 * uploads once. The engine never learns which rule chose a shape, only which
 * shape to draw -- which is why overrides and I-beam detection needed no engine
 * changes at all once the table existed.
 *
 * Deduping matters because a ten minute recording holds thousands of events and
 * perhaps a dozen shapes: keying the table on the image keeps what crosses the
 * IPC boundary proportional to the shapes rather than the samples.
 *
 * The key includes the hotspot. Two events sharing a bitmap almost always share
 * its hotspot too, but a table that assumed so would put the tip in the wrong
 * place for the ones that do not, and that shows up only as clicks landing
 * slightly off.
 */
export interface CursorBitmapTable {
  /** Upload order. An event's id is its index here. */
  images: RgbaBitmap[];
  /**
   * The id for an event at `compositionMs`, or `undefined` for the default.
   *
   * Takes the time as well as the event because an override is a property of
   * the moment rather than of the pointer -- the same event inside an override
   * span and outside it draws two different shapes.
   */
  idFor: (event: CompositionCursorEvent, compositionMs: number) => number | undefined;
}

const EMPTY_TABLE: CursorBitmapTable = { images: [], idFor: () => undefined };

/** The override covering `compositionMs`, if any. */
function overrideAt(
  cursor: CompositionCursorConfig,
  compositionMs: number,
): CompositionCursorRegionOverride | undefined {
  const overrides = cursor.cursorRegionOverrides;
  if (!overrides || overrides.length === 0) {
    return undefined;
  }

  const covering = overrides.find(
    (region) => compositionMs >= region.startMs && compositionMs < region.endMs,
  );
  if (covering) {
    return covering;
  }

  // The compositor includes the last override's closing instant, so a playhead
  // parked exactly on it keeps the override instead of flickering back to the
  // recorded pointer for a single frame.
  const last = overrides[overrides.length - 1];
  return last && compositionMs === last.endMs ? last : undefined;
}

/** The key for the bitmap the recorder captured with an event, if it did. */
function capturedKey(event: CompositionCursorEvent): string | null {
  if (typeof event.cursorDataUrl !== 'string' || event.cursorDataUrl.length === 0) {
    return null;
  }
  return `captured:${event.cursorDataUrl}|${event.cursorHotspotX ?? 0}|${event.cursorHotspotY ?? 0}`;
}

/** Which table entry an event wants, by the rules the compositor uses. */
function keyFor(
  cursor: CompositionCursorConfig,
  event: CompositionCursorEvent,
  compositionMs: number,
): string | null {
  const region = overrideAt(cursor, compositionMs);
  if (region) {
    return `override:${region.imagePath}`;
  }
  if (isIBeamCursorHandle(event.cursorHandleHex)) {
    return 'ibeam';
  }
  return capturedKey(event);
}

/**
 * The I-beam, rasterised.
 *
 * Drawn centred on its point -- the stem spans the height either side of it --
 * so the sprite is symmetric and its hotspot is the middle. Padded by a couple
 * of pixels, because the glyph draws a halo one pixel outside the bars.
 */
function rasteriseIBeam(): RgbaBitmap | null {
  const stemHeight = GLYPH_SIZE_PX * 1.9;
  const capWidth = Math.max(Math.max(2, GLYPH_SIZE_PX * 0.16) * 2.6, GLYPH_SIZE_PX * 0.64);
  const width = Math.ceil(capWidth) + 4;
  const height = Math.ceil(stemHeight) + 4;

  const ctx = createContext(width, height);
  if (!ctx) {
    return null;
  }

  drawIBeamCursor(ctx, width / 2, height / 2, GLYPH_SIZE_PX);
  return { ...readBack(ctx), hotspotX: width / 2, hotspotY: height / 2 };
}

/**
 * Load the bitmap a key names.
 *
 * An override draws from its image's top-left, matching the compositor, which
 * passes no hotspot for one. That is arguably wrong -- a replacement pointer
 * has a tip too -- but it is what the other path does, and the two disagreeing
 * would be worse than both being slightly off.
 */
async function loadForKey(key: string, event: CompositionCursorEvent): Promise<RgbaBitmap | null> {
  if (key === 'ibeam') {
    return rasteriseIBeam();
  }

  if (key.startsWith('override:')) {
    const loaded = await loadImageBitmap(key.slice('override:'.length));
    return loaded && { ...loaded, hotspotX: 0, hotspotY: 0 };
  }

  const loaded = await loadImageBitmap(event.cursorDataUrl as string);
  return (
    loaded && {
      ...loaded,
      hotspotX: event.cursorHotspotX ?? 0,
      hotspotY: event.cursorHotspotY ?? 0,
    }
  );
}

/**
 * Build the table for a recording.
 *
 * `timeOf` maps an event to the composition time the engine will look it up at,
 * so overrides resolve against the same clock the track is built on. Getting
 * this wrong would change the pointer's shape at the right instant of the wrong
 * timeline, which after a cut is a quiet drift rather than an obvious break.
 */
export async function buildCursorBitmapTable(
  cursor: CompositionCursorConfig | undefined,
  timeOf: (event: CompositionCursorEvent) => number,
): Promise<CursorBitmapTable> {
  if (!cursor?.enabled || cursor.events.length === 0) {
    return EMPTY_TABLE;
  }

  // One entry per distinct shape, in first-seen order.
  const firstSeen = new Map<string, CompositionCursorEvent>();
  for (const event of cursor.events) {
    const key = keyFor(cursor, event, timeOf(event));
    if (key !== null && !firstSeen.has(key)) {
      firstSeen.set(key, event);
    }
  }

  if (firstSeen.size === 0) {
    return EMPTY_TABLE;
  }

  const images: RgbaBitmap[] = [];
  const idByKey = new Map<string, number>();

  for (const [key, event] of firstSeen) {
    const loaded = await loadForKey(key, event);
    if (!loaded) {
      // One shape failing to decode costs that shape, not the table -- the
      // events that wanted it fall back to the default pointer.
      continue;
    }
    idByKey.set(key, images.length);
    images.push(loaded);
  }

  return {
    images,
    idFor: (event, compositionMs) => {
      const key = keyFor(cursor, event, compositionMs);
      return key === null ? undefined : idByKey.get(key);
    },
  };
}
