/**
 * Making renderer-sent export options safe to hand to napi.
 *
 * Two things do not survive the trip from the renderer intact, and neither is
 * visible to the type checker:
 *
 * **Pixel buffers arrive as `ArrayBuffer`.** Structured clone turns a Node
 * `Buffer` into a plain `ArrayBuffer`, and napi will not take one -- it wants a
 * `Buffer` or a typed array. The main-process types say `Buffer` because that is
 * what napi needs, so TypeScript is describing the destination rather than what
 * actually shows up, and it cannot warn about the difference. The player's IPC
 * handlers have always converted; the export path did not, and failed with
 * "Failed to get Buffer pointer and length on CursorBitmap.pixels".
 *
 * **Paths arrive quoted.** Media Foundation rejects the quoted form outright,
 * which shows up as a file that will not open rather than as a bad argument.
 *
 * Pure and in its own file so it can be tested. `export.service.ts` cannot be
 * loaded outside Electron, which is precisely why a bug in this conversion
 * survived to reach a user.
 */

import type { CursorBitmap, ExportOptions } from '../../types/engine.types.js';
import { normalizeMediaPath } from './paths.js';

/** What a pixel buffer looks like once structured clone has been at it. */
type WireBuffer = Buffer | ArrayBuffer | Uint8Array;

function toBuffer(pixels: WireBuffer): Buffer {
  // Already the right thing when the caller is in this process; a copy would
  // only cost a canvas-sized allocation for nothing.
  if (Buffer.isBuffer(pixels)) {
    return pixels;
  }
  return Buffer.from(pixels as ArrayBuffer);
}

function normaliseBitmap<T extends CursorBitmap | undefined>(bitmap: T): T {
  if (!bitmap) {
    return bitmap;
  }
  return { ...bitmap, pixels: toBuffer(bitmap.pixels as WireBuffer) };
}

/**
 * Everything napi needs fixed up, in one pass.
 *
 * Deliberately covers every bitmap the options can carry rather than the one
 * that happened to fail: the cursor, the per-sample cursor table, and the
 * background image are the same kind of thing arriving the same way, and fixing
 * only the one in the stack trace would leave the next two to be found the same
 * way -- by a user, at the end of a recording.
 */
export function normaliseExportOptions(input: string, options: ExportOptions) {
  return {
    input: normalizeMediaPath(input),
    options: {
      ...options,
      output: normalizeMediaPath(options.output),
      // The sidecar comes from the same place the input did, so it needs the
      // same de-quoting.
      webcamPath: options.webcamPath ? normalizeMediaPath(options.webcamPath) : undefined,
      audioSources: options.audioSources?.map((source) => ({
        ...source,
        path: normalizeMediaPath(source.path),
      })),
      cursor: normaliseBitmap(options.cursor),
      cursorImages: options.cursorImages?.map((image) => normaliseBitmap(image)),
      background: options.background
        ? { ...options.background, image: normaliseBitmap(options.background.image) }
        : undefined,
    },
  };
}
