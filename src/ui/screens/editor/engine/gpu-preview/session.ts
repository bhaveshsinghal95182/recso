/**
 * The GPU preview's lifecycle: open a player, keep it in sync with the
 * composition, and pump frames into a canvas.
 *
 * This is the other integration, and the distinction matters. `GpuFrameSource`
 * would let the engine act as a *decoder* for the Canvas2D compositor -- but
 * that reads every frame back to the CPU and throws away everything the engine
 * composites, so it would be slower than the `<video>` path it replaced. Here
 * the engine composites the whole frame and hands the finished texture to a
 * canvas through `importSharedTexture`; nothing crosses to the CPU.
 *
 * One consequence worth knowing: only one frame sink can be bound at a time, so
 * this and the dev harness cannot both be live.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Project } from '@/types';

import type { CanvasSize } from '../preview-config/types';
import type { CompositionConfig } from '../types';
import type { ResolvedComposition } from './config-to-engine';
import { applyComposition } from './config-to-engine';

export interface GpuPreviewState {
  /** Whether the engine has a file open and is presenting. */
  ready: boolean;
  /** Null until something goes wrong; the caller shows it and falls back. */
  error: string | null;
  /** Playhead in composition milliseconds, from the engine's own clock. */
  currentTimeMs: number;
  /** The edit's length: the file's duration less what has been cut. */
  durationMs: number;
  /**
   * Whether the engine's own clock is still running.
   *
   * The engine stops itself once the decoder is finished and the frame queue has
   * drained, and this is the only way the editor finds out. Without it the
   * transport stays stuck in "playing" after the recording ends.
   */
  playing: boolean;
  /**
   * The decoder has reached the end of the file. Cleared on seek, so it reads as
   * "playback finished" rather than "this player has finished once".
   */
  endOfStream: boolean;
}

export interface UseGpuPreviewOptions {
  enabled: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** A CSS selector matching `canvasRef`, since the main process binds by name. */
  canvasSelector: string;
  project: Project | null;
  config: CompositionConfig;
  canvasSize: CanvasSize;
  isPlaying: boolean;
  /** Composition milliseconds the editor wants shown. */
  seekToMs: number | null;
  /** Changes only for explicit user seeks, not for engine clock updates. */
  seekRequestId: number;
  /** The camera sidecar, if the recording has one. */
  webcamPath?: string;
}

function logBlankPreviewFrame(canvas: HTMLCanvasElement, currentTimeMs: number): void {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || canvas.width === 0 || canvas.height === 0) {
    return;
  }

  const sampleWidth = Math.min(32, canvas.width);
  const sampleHeight = Math.min(32, canvas.height);
  const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  let min = 255;
  let max = 0;
  let opaque = 0;
  let black = 0;

  for (let index = 0; index < pixels.length; index += 4) {
    const brightness = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
    min = Math.min(min, brightness);
    max = Math.max(max, brightness);
    if (pixels[index + 3] > 8) opaque += 1;
    if (brightness < 8) black += 1;
  }

  const pixelCount = pixels.length / 4;
  if (opaque === 0 || black === pixelCount || max - min <= 1) {
    console.warn('[blank-frame-trace][gpu-preview]', {
      currentTimeMs,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      minBrightness: min,
      maxBrightness: max,
      opaquePixels: opaque,
      sampledPixels: pixelCount,
    });
  }
}

export function useGpuPreview({
  enabled,
  canvasRef,
  canvasSelector,
  project,
  config,
  canvasSize,
  isPlaying,
  seekToMs,
  seekRequestId,
  webcamPath,
}: UseGpuPreviewOptions): GpuPreviewState {
  const [state, setState] = useState<GpuPreviewState>({
    ready: false,
    error: null,
    currentTimeMs: 0,
    durationMs: 0,
    playing: false,
    endOfStream: false,
  });

  const openRef = useRef(false);
  const seekToMsRef = useRef(seekToMs);
  seekToMsRef.current = seekToMs;
  /**
   * `tick` is an IPC round trip. Without this a slow frame stacks calls until
   * the queue is the only thing the main process is doing.
   */
  const tickInFlight = useRef(false);
  const rafRef = useRef<number | null>(null);
  /**
   * What the open player has already been told, so an unchanged background is
   * not re-sent. Cleared around every open, because a new player has been told
   * nothing.
   */
  const appliedRef = useRef<ResolvedComposition | null>(null);

  const path = project?.rawVideoPath ?? '';

  // ---- open and close ------------------------------------------------------

  useEffect(() => {
    if (!enabled || !path) {
      return;
    }

    let cancelled = false;
    openRef.current = false;
    appliedRef.current = null;

    const engine = window.electron.engine;

    void (async () => {
      try {
        engine.bindFrameSink(canvasSelector);
        // The canvas has to be passed at open: it is the size of the textures
        // Chromium imports, so it cannot change without redoing that handshake.
        const opened = await engine.player.open(path, {
          webcamPath: webcamPath || undefined,
          canvasWidth: canvasSize.width,
          canvasHeight: canvasSize.height,
        });
        if (cancelled) {
          return;
        }

        openRef.current = true;
        setState((previous) => ({
          ...previous,
          ready: true,
          error: null,
          durationMs: opened.duration,
        }));
      } catch (error) {
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            ready: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
      openRef.current = false;
      appliedRef.current = null;
      engine.unbindFrameSink();
      void engine.player.close();
      setState((previous) => ({ ...previous, ready: false }));
    };
    // A canvas resize reopens, because the size is fixed for a player's life.
  }, [enabled, path, canvasSelector, webcamPath, canvasSize.width, canvasSize.height]);

  // ---- keep the composition in sync ----------------------------------------

  useEffect(() => {
    if (!enabled || !state.ready) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const applied = await applyComposition(
          window.electron.engine.player,
          config,
          canvasSize,
          project,
          appliedRef.current,
        );
        if (!cancelled) {
          appliedRef.current = applied;
          const durationMs = await window.electron.engine.player.compositionDuration();
          setState((previous) => ({ ...previous, durationMs }));
        }
      } catch (error) {
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, state.ready, config, canvasSize, project]);

  // ---- transport -----------------------------------------------------------

  useEffect(() => {
    if (!enabled || !state.ready) {
      return;
    }
    void (isPlaying ? window.electron.engine.player.play() : window.electron.engine.player.pause());
  }, [enabled, state.ready, isPlaying]);

  useEffect(() => {
    if (!enabled || !state.ready || seekToMsRef.current === null) {
      return;
    }
    void window.electron.engine.player.seek(seekToMsRef.current, true);
  }, [enabled, state.ready, seekRequestId]);

  // ---- present -------------------------------------------------------------

  const pump = useCallback(() => {
    rafRef.current = requestAnimationFrame(pump);

    if (!openRef.current || tickInFlight.current) {
      return;
    }

    tickInFlight.current = true;
    window.electron.engine.player
      .tick()
      .then((result) => {
        if (result) {
          if (result.presented && canvasRef.current) {
            logBlankPreviewFrame(canvasRef.current, result.currentTime);
          }
          setState((previous) =>
            previous.currentTimeMs === result.currentTime &&
            previous.playing === result.playing &&
            previous.endOfStream === result.endOfStream
              ? previous
              : {
                  ...previous,
                  currentTimeMs: result.currentTime,
                  playing: result.playing,
                  endOfStream: result.endOfStream,
                },
          );
        }
      })
      .catch(() => {
        // A failed tick is a dropped frame, not a broken session. The next one
        // is 16ms away, and logging every one of them would bury the console.
      })
      .finally(() => {
        tickInFlight.current = false;
      });
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    rafRef.current = requestAnimationFrame(pump);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, pump]);

  useEffect(() => {
    if (!enabled || !canvasRef.current) {
      return;
    }
    canvasRef.current.width = canvasSize.width;
    canvasRef.current.height = canvasSize.height;
  }, [enabled, canvasRef, canvasSize.width, canvasSize.height]);

  return state;
}
