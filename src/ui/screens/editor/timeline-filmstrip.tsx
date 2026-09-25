/**
 * TimelineFilmstrip
 *
 * Draws a lane's spritesheet as a strip of thumbnails behind everything else on
 * that lane. The layout maths lives in `filmstrip.ts` and is tested there; this
 * file is only the effectful shell — load a PNG off disk, size a canvas, and
 * blit the rectangles the pure core hands back.
 *
 * Sheets are decoded once per image URL and cached for the lifetime of the app,
 * the same bargain `timeline-waveform.tsx` makes with decoded peaks: a couple of
 * bitmaps per project, never evicted, in exchange for never re-decoding on a
 * remount or a filter switch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { filmstripCells, frameRect } from '@/screens/editor/filmstrip';
import type { SpritesheetMeta } from '@/types';

/**
 * How brightly the thumbnails sit in the lane.
 *
 * The strip is a texture, not a picture. Cut and zoom chips, the waveform and
 * the playhead all draw on top of it, and the lane's own surfaces live around
 * 0.02–0.07 alpha — a full-brightness screen recording would out-shout every
 * one of them. This is a little above the waveform's 0.16 because that draws
 * pure white at its peaks while a thumbnail averages out mid-luminance, so the
 * same alpha would read much fainter.
 */
const FILMSTRIP_ALPHA = 0.24;

const sheetImageCache = new Map<string, Promise<HTMLImageElement>>();

function toFileUrl(path: string): string {
  if (path.startsWith('file:')) {
    return path;
  }

  const normalized = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }

  if (normalized.startsWith('/')) {
    return `file://${encodeURI(normalized)}`;
  }

  return normalized;
}

/**
 * The URL a sheet's PNG is loaded from.
 *
 * Regenerating a sheet overwrites the same path, so without a cache buster the
 * renderer keeps serving the bitmap it already decoded and the lane shows
 * thumbnails of a recording that no longer exists. The source video's mtime is
 * exactly the thing that changed, so it makes the URL new.
 *
 * Chromium resolves a `file:` URL from its path component alone and ignores the
 * query, so the query changes cache identity without changing which file is
 * read.
 */
function sheetImageUrl(sheet: SpritesheetMeta): string {
  const base = toFileUrl(sheet.imagePath);
  const version = Number.isFinite(sheet.sourceModifiedMs) ? Math.trunc(sheet.sourceModifiedMs) : 0;
  return `${base}?v=${version}`;
}

async function loadSheetImage(url: string): Promise<HTMLImageElement> {
  const cached = sheetImageCache.get(url);
  if (cached) {
    return cached;
  }

  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();

    image.onload = () => {
      // A zero-sized bitmap still fires `load` — a half-written PNG caught
      // mid-generation can do it — and `drawImage` throws on one rather than
      // no-opping like it does for an undecodable source.
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        reject(new Error(`Spritesheet image decoded to nothing: ${url}`));
        return;
      }

      resolve(image);
    };

    image.onerror = () => {
      reject(new Error(`Failed to load spritesheet image: ${url}`));
    };

    image.src = url;
  });

  sheetImageCache.set(url, pending);

  try {
    return await pending;
  } catch (error) {
    // Drop the failure so a later mount retries rather than inheriting it. The
    // strip stays blank until then; nothing here retries on its own.
    sheetImageCache.delete(url);
    throw error;
  }
}

interface TimelineFilmstripProps {
  /** The lane's sheet, absent until one has finished generating. */
  sheet: SpritesheetMeta | undefined;
  /** Project duration in milliseconds — what the lane's full width spans. */
  durationMs: number;
}

export function TimelineFilmstrip({ sheet, durationMs }: TimelineFilmstripProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const imageUrl = sheet ? sheetImageUrl(sheet) : null;

  useEffect(() => {
    // Clearing first matters when the URL changes under us: a regenerated sheet
    // should not be represented by the bitmap it replaced.
    setImage(null);

    if (!imageUrl) {
      return;
    }

    let cancelled = false;

    void loadSheetImage(imageUrl)
      .then((loaded) => {
        if (!cancelled) {
          setImage(loaded);
        }
      })
      .catch((error: unknown) => {
        // Not fatal — the lane just goes back to its empty state — but it means
        // the sheet on disk is missing or unreadable, which is worth saying.
        console.warn('[TimelineFilmstrip] sheet image unavailable:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  const drawFilmstrip = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(rect.width));
    const cssHeight = Math.max(1, Math.floor(rect.height));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const bufferWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const bufferHeight = Math.max(1, Math.floor(cssHeight * dpr));

    if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
      canvas.width = bufferWidth;
      canvas.height = bufferHeight;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (!sheet || !image || !(durationMs > 0)) {
      return;
    }

    const cells = filmstripCells({
      laneWidthPx: cssWidth,
      laneHeightPx: cssHeight,
      cellAspect: sheet.frameWidth / sheet.frameHeight,
      durationMs,
    });

    ctx.save();
    ctx.globalAlpha = FILMSTRIP_ALPHA;

    for (const cell of cells) {
      const source = frameRect(sheet, cell.timeMs);
      if (!source) {
        // Null is a verdict on the sheet's geometry, not on this instant, so
        // it is null for every cell or for none. Nothing left to draw.
        break;
      }

      ctx.drawImage(
        image,
        source.sx,
        source.sy,
        source.sw,
        source.sh,
        cell.xPx,
        0,
        cell.widthPx,
        cssHeight,
      );
    }

    ctx.restore();
  }, [durationMs, image, sheet]);

  useEffect(() => {
    drawFilmstrip();
  }, [drawFilmstrip]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const observer = new ResizeObserver(() => {
      drawFilmstrip();
    });
    observer.observe(canvas);

    return () => {
      observer.disconnect();
    };
  }, [drawFilmstrip]);

  // No sheet yet, and there may never be one — render nothing at all so the
  // lane's own empty hint shows through instead of an empty canvas over it.
  if (!sheet) {
    return null;
  }

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
}
