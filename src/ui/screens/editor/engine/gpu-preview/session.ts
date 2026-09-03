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
  /** The camera sidecar, if the recording has one. */
  webcamPath?: string;
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
  webcamPath,
}: UseGpuPreviewOptions): GpuPreviewState {
  const [state, setState] = useState<GpuPreviewState>({
    ready: false,
    error: null,
    currentTimeMs: 0,
    durationMs: 0,
  });

  const openRef = useRef(false);
  /**
   * `tick` is an IPC round trip. Without this a slow frame stacks calls until
   * the queue is the only thing the main process is doing.
   */
  const tickInFlight = useRef(false);
  const rafRef = useRef<number | null>(null);

  const path = project?.rawVideoPath ?? '';

  // ---- open and close ------------------------------------------------------

  useEffect(() => {
    if (!enabled || !path) {
      return;
    }

    let cancelled = false;
    openRef.current = false;

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
        await applyComposition(window.electron.engine.player, config, canvasSize, project);
        if (!cancelled) {
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
    if (!enabled || !state.ready || seekToMs === null) {
      return;
    }
    void window.electron.engine.player.seek(seekToMs, true);
  }, [enabled, state.ready, seekToMs]);

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
          setState((previous) =>
            previous.currentTimeMs === result.currentTime
              ? previous
              : { ...previous, currentTimeMs: result.currentTime },
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
