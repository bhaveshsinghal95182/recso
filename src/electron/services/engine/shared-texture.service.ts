import { sharedTexture } from 'electron';

import type { WebFrameMain } from 'electron';

import type { SharedTextureInfo } from '../../types/engine.types.js';
import { textureHandle } from './texture-handle.js';

/**
 * Electron wants the NT handle as bytes, but a texture pool only has a handful
 * of distinct handles and they never change. Caching one Buffer per handle
 * keeps the per-frame path allocation-free.
 */
const handleBuffers = new Map<number, Buffer>();

function handleBuffer(handle: number): Buffer {
  let buffer = handleBuffers.get(handle);
  if (!buffer) {
    buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(handle));
    handleBuffers.set(handle, buffer);
  }
  return buffer;
}

/** Called when a player closes, since its handles die with it. */
export function clearHandleCache(): void {
  handleBuffers.clear();
}

/**
 * Formats Electron will import.
 *
 * Notably not nv12. Electron's rules are opposite either way -- it requires
 * *no* keyed mutex on these and *a* keyed mutex on nv12 -- which is why the
 * player's pool is BGRA. The raw `VideoDecoder` diagnostic path can still hand
 * out NV12, so this is checked rather than assumed: without it the failure is
 * a garbled or green preview with every layer reporting success.
 */
const IMPORTABLE_FORMATS = ['bgra', 'rgba', 'rgbaf16'] as const;

type ImportablePixelFormat = (typeof IMPORTABLE_FORMATS)[number];

function assertImportable(format: string): ImportablePixelFormat {
  if (!(IMPORTABLE_FORMATS as readonly string[]).includes(format)) {
    throw new Error(
      `cannot import a "${format}" shared texture: Electron only accepts ` +
        `${IMPORTABLE_FORMATS.join(', ')}. Render it through the engine's ` +
        'render chain before presenting it.',
    );
  }
  return format as ImportablePixelFormat;
}

/**
 * Hand one native D3D11 texture to a renderer frame.
 *
 * The NT handle in `info.handle` is only valid in this process, which is fine:
 * the addon that created it is loaded here, and Electron duplicates the handle
 * into the GPU process during import.
 */
export async function sendTextureToFrame(
  frame: WebFrameMain,
  info: SharedTextureInfo,
  ...args: unknown[]
): Promise<void> {
  const imported = sharedTexture.importSharedTexture({
    textureInfo: {
      handle: textureHandle(info, handleBuffer),
      codedSize: { width: info.width, height: info.height },
      // Decoders pad to macroblock alignment, so the visible area is often
      // smaller than the allocation. Getting this wrong shows up as a green
      // or garbage strip along an edge.
      visibleRect: {
        x: 0,
        y: 0,
        width: info.visibleWidth,
        height: info.visibleHeight,
      },
      pixelFormat: assertImportable(info.pixelFormat),
      timestamp: info.timestamp,
    },
  });

  try {
    // Throws after 1000ms if the renderer never registered a receiver.
    await sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imported }, ...args);
  } finally {
    // Drop our reference. The renderer holds its own; the GPU resource dies
    // when the last one is released.
    imported.release();
  }
}
