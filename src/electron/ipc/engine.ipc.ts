/**
 * EngineIPC — IPC handlers for the GPU video engine.
 *
 * Provides:
 * - Availability + diagnostics (`engine:status`, `engine:diagnostics`)
 * - Player transport (open/warm/play/pause/rate/seek/tick/effects/stats)
 * - Engine-side export (start/progress/cancel)
 *
 * This is a second, parallel path. It does not touch the compositor, the
 * mediabunny exporter, or anything the editor currently uses -- every handler
 * here is namespaced `engine:` and is only reachable from code that asks for
 * it. See `docs/ENGINE.md` for how the two paths are meant to converge.
 *
 * Every handler tolerates a missing addon: `engine:status` reports it, and the
 * rest throw a readable error rather than crashing the main process.
 */

import { ipcMain } from 'electron';

import { getRecording } from '../services/database.service.js';
import {
  cancelEngineExport,
  engineExportProgress,
  startEngineExport,
} from '../services/engine/export.service.js';
import { gpuSummary } from '../services/engine/gpu.service.js';
import {
  engineLoadError,
  isEngineAvailable,
  requireEngineBindings,
} from '../services/engine/native.js';
import { normalizeMediaPath } from '../services/engine/paths.js';
import {
  closePlayer,
  openPlayer,
  presentTick,
  requirePlayer,
  warmPool,
} from '../services/engine/player.service.js';
import type {
  CursorBitmap,
  CursorPoint,
  ExportOptions,
  WebcamOverlay,
} from '../types/engine.types.js';

export function registerEngineHandlers(): void {
  // ---- availability + diagnostics -----------------------------------------

  /**
   * Safe to call before anything else, and the only handler that never throws.
   * The renderer uses this to decide whether to offer the GPU path at all.
   */
  ipcMain.handle('engine:status', () => {
    const available = isEngineAvailable();
    return {
      available,
      error: available ? null : engineLoadError(),
      version: available ? requireEngineBindings().engineVersion() : null,
      gpu: gpuSummary(),
    };
  });

  ipcMain.handle('engine:diagnostics', () => {
    const bindings = requireEngineBindings();
    return {
      adapters: bindings.adapterInfo(),
      decoders: bindings.listDecoders(),
      gpuProfiles: bindings.gpuDecoderProfiles(),
      memory: bindings.gpuMemory(),
    };
  });

  /**
   * What Media Foundation sees in a file.
   *
   * Worth calling before opening anything the user picked: an HEVC recording
   * opens fine and then fails at the first decode, and this is the difference
   * between saying so up front and failing halfway through playback.
   */
  ipcMain.handle('engine:probe', (_event, path: string) =>
    requireEngineBindings().probeVideo(normalizeMediaPath(path)),
  );

  ipcMain.handle('engine:gpu-memory', () => requireEngineBindings().gpuMemory());

  // ---- player -------------------------------------------------------------

  ipcMain.handle('engine:player:open', (_event, path: string) => openPlayer(path));

  /**
   * Open a recording in the engine using what the recorder said about it.
   *
   * This is the path that has no probe in it anywhere: the recorder measured
   * geometry, duration, frame count and real fps at capture time, that went
   * into the database with the recording, and it comes straight back out here.
   * Files with no stored metadata still open -- they just fall back to what
   * the container claims.
   */
  ipcMain.handle('engine:player:open-recording', (_event, recordingId: string) => {
    const recording = getRecording(recordingId);

    if (!recording) {
      throw new Error(`no recording ${recordingId}`);
    }
    if (!recording.finalPath) {
      throw new Error(`recording ${recordingId} has no finished file`);
    }

    const opened = openPlayer(recording.finalPath, recording.mediaInfo);

    for (const note of opened.disagreements) {
      console.warn(`[engine] ${recording.finalPath}: ${note}`);
    }

    return opened;
  });

  ipcMain.handle('engine:player:close', () => closePlayer());

  ipcMain.handle('engine:player:warm', async (event) => {
    const frame = event.senderFrame;
    if (!frame) throw new Error('no sender frame');
    return warmPool(frame);
  });

  ipcMain.handle('engine:player:play', () => requirePlayer().play());
  ipcMain.handle('engine:player:pause', () => requirePlayer().pause());
  ipcMain.handle('engine:player:rate', (_event, rate: number) => requirePlayer().setRate(rate));

  ipcMain.handle('engine:player:seek', (_event, ms: number, exact: boolean) => {
    requirePlayer().seek(ms, exact);
  });

  ipcMain.handle('engine:player:tick', async (event) => {
    const frame = event.senderFrame;
    if (!frame) throw new Error('no sender frame');
    return presentTick(frame);
  });

  ipcMain.handle(
    'engine:player:effects',
    (_event, brightness: number, contrast: number, saturation: number) => {
      requirePlayer().setEffects(brightness, contrast, saturation);
    },
  );

  // ---- composition --------------------------------------------------------
  //
  // Each of these re-renders the frames already queued rather than re-decoding,
  // so they are cheap enough to fire from a drag.

  ipcMain.handle('engine:player:webcam-layout', (_event, layout: WebcamOverlay) => {
    requirePlayer().setWebcamLayout(layout);
  });

  ipcMain.handle('engine:player:has-webcam', () => requirePlayer().hasWebcam());

  /**
   * `pixels` arrives as an ArrayBuffer over IPC; the addon wants a Buffer.
   * Wrapping rather than copying, since the bitmap is uploaded once and the
   * copy would be pure waste on every cursor change.
   */
  ipcMain.handle(
    'engine:player:cursor-image',
    (_event, image: (Omit<CursorBitmap, 'pixels'> & { pixels: ArrayBuffer }) | null) => {
      if (!image) {
        requirePlayer().setCursorImage(null);
        return;
      }
      requirePlayer().setCursorImage({ ...image, pixels: Buffer.from(image.pixels) });
    },
  );

  ipcMain.handle('engine:player:cursor-track', (_event, samples: CursorPoint[]) => {
    requirePlayer().setCursorTrack(samples);
  });

  ipcMain.handle('engine:player:cursor-style', (_event, size: number, opacity: number) => {
    requirePlayer().setCursorStyle(size, opacity);
  });

  ipcMain.handle('engine:player:cursor-sample-count', () => requirePlayer().cursorSampleCount());

  /**
   * The composited frame as raw BGRA.
   *
   * Returned as an ArrayBuffer so it crosses IPC without being turned into a
   * JSON array of eight million numbers.
   */
  ipcMain.handle('engine:player:snapshot', () => {
    const pixels = requirePlayer().snapshotBgra();
    if (!pixels) {
      return null;
    }
    const info = requirePlayer().info();
    return {
      width: info.codedWidth,
      height: info.codedHeight,
      pixels: pixels.buffer.slice(
        pixels.byteOffset,
        pixels.byteOffset + pixels.byteLength,
      ) as ArrayBuffer,
    };
  });

  ipcMain.handle('engine:player:stats', () => requirePlayer().stats());

  // ---- export -------------------------------------------------------------

  ipcMain.handle('engine:export:start', (_event, input: string, options: ExportOptions) =>
    startEngineExport(input, options),
  );

  ipcMain.handle('engine:export:progress', () => engineExportProgress());
  ipcMain.handle('engine:export:cancel', () => cancelEngineExport());
}
