/**
 * Dev harness for the GPU video engine.
 *
 * The engine is a parallel path: nothing in the editor drives it yet, so
 * without this there is no way to exercise decode, grading, presentation and
 * export end to end inside recso. It is the equivalent of the prototype's app
 * window, and it is where the numbers in `docs/ENGINE.md` come from.
 *
 * Not reachable in a production build -- see the `engine` case in `App.tsx`.
 *
 * Note this binds its *own* visible canvas as the frame sink. There is one
 * sink at a time, so the editor's hidden sink and this cannot both be live;
 * that is fine while nothing in the editor uses the engine.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import type {
  EngineExportProgress,
  EnginePlayerStats,
  EngineStatus,
  EngineTickResult,
  EngineVideoInfo,
} from '../../electron.d';

const PREVIEW_CANVAS_ID = 'engine-harness-preview';
const PREVIEW_SELECTOR = `#${PREVIEW_CANVAS_ID}`;

const IDENTITY_EFFECTS = { brightness: 0, contrast: 1, saturation: 1 };

type Effects = typeof IDENTITY_EFFECTS;

const EFFECT_RANGES: Record<keyof Effects, { min: number; max: number; step: number }> = {
  brightness: { min: -0.5, max: 0.5, step: 0.01 },
  contrast: { min: 0, max: 2, step: 0.01 },
  saturation: { min: 0, max: 2, step: 0.01 },
};

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function EngineHarnessScreen() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [videoPath, setVideoPath] = useState('');
  const [info, setInfo] = useState<EngineVideoInfo | null>(null);
  const [tick, setTick] = useState<EngineTickResult | null>(null);
  const [stats, setStats] = useState<EnginePlayerStats | null>(null);
  const [effects, setEffects] = useState<Effects>(IDENTITY_EFFECTS);
  const [exportProgress, setExportProgress] = useState<EngineExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubMs, setScrubMs] = useState(0);

  /**
   * tick() is a round trip. Without this guard a slow frame stacks invocations
   * and the queue only ever gets deeper.
   */
  const tickInFlight = useRef(false);
  const openRef = useRef(false);

  useEffect(() => {
    window.electron.engine
      .status()
      .then(setStatus)
      .catch((e: Error) => {
        // status() is the one call that is supposed to be safe to make
        // unconditionally, so a rejection here means the bridge itself is
        // broken. Surface it rather than sitting on a null status forever.
        setStatus({ available: false, error: e.message, version: null, gpu: null });
      });
  }, []);

  // The receiver is registered in preload at load time, but it has nowhere to
  // paint until a sink is bound. Bind on mount, release on unmount.
  useEffect(() => {
    window.electron.engine.bindFrameSink(PREVIEW_SELECTOR);
    return () => window.electron.engine.unbindFrameSink();
  }, []);

  // Drive presentation. The engine owns the clock and decides what is due, so
  // this loop just asks every vsync and paints whatever comes back.
  useEffect(() => {
    let raf = 0;

    const pump = () => {
      raf = requestAnimationFrame(pump);

      if (!openRef.current || tickInFlight.current) {
        return;
      }

      tickInFlight.current = true;
      window.electron.engine.player
        .tick()
        .then(setTick)
        .catch(() => {
          /* player closed mid-flight */
        })
        .finally(() => {
          tickInFlight.current = false;
        });
    };

    raf = requestAnimationFrame(pump);
    return () => cancelAnimationFrame(raf);
  }, []);

  const open = useCallback(async () => {
    if (!videoPath.trim()) return;

    setBusy(true);
    setError(null);

    try {
      // Probe first. An HEVC file opens fine and then fails at the first
      // decode, and saying so here is much clearer than a stalled preview.
      const probe = await window.electron.engine.probe(videoPath);
      if (!probe.opened) {
        setError(probe.error || 'Media Foundation could not open this file');
        return;
      }

      const opened = await window.electron.engine.player.open(videoPath);
      setInfo(opened);
      openRef.current = true;

      // Costs a few hundred ms once and saves a stall in the first second of
      // playback. Worth doing before anything is on screen.
      await window.electron.engine.player.warm();
      await window.electron.engine.player.setEffects(
        effects.brightness,
        effects.contrast,
        effects.saturation,
      );
    } catch (e) {
      setError((e as Error).message);
      openRef.current = false;
    } finally {
      setBusy(false);
    }
  }, [videoPath, effects]);

  const close = useCallback(async () => {
    openRef.current = false;
    setInfo(null);
    setTick(null);
    setStats(null);
    await window.electron.engine.player.close();
  }, []);

  const applyEffects = useCallback(async (next: Effects) => {
    setEffects(next);
    try {
      await window.electron.engine.player.setEffects(
        next.brightness,
        next.contrast,
        next.saturation,
      );
    } catch {
      /* nothing open */
    }
  }, []);

  const seek = useCallback(async (ms: number, exact: boolean) => {
    try {
      await window.electron.engine.player.seek(ms, exact);
    } catch {
      /* nothing open */
    }
  }, []);

  const startExport = useCallback(async () => {
    if (!info) return;

    try {
      const output = videoPath.replace(/\.[^.]+$/, '') + '_engine.mp4';
      await window.electron.engine.export.start(videoPath, {
        output,
        bitrate: 12_000_000,
        ...effects,
      });

      // Poll. The exporter runs on its own Rust thread and reports setup time
      // separately from steady-state fps, because on a short clip the setup
      // dominates and makes a faster GPU look slower.
      const poll = window.setInterval(async () => {
        const progress = await window.electron.engine.export.progress();
        setExportProgress(progress);
        if (!progress || progress.finished) {
          window.clearInterval(poll);
        }
      }, 250);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [info, videoPath, effects]);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await window.electron.engine.player.stats());
    } catch {
      /* nothing open */
    }
  }, []);

  /**
   * Unattended presentation check.
   *
   * The headless script covers decode, seek, grading and export, but it cannot
   * cover presentation -- that needs a live Chromium GPU process. And this is
   * the path with the nastiest failure mode: if the engine and Chromium end up
   * on different adapters, every layer reports success and the canvas is
   * silently black. So this plays for a moment and then *reads the canvas
   * back*, which is the only way to tell those two apart.
   *
   *   VITE_ENGINE_AUTORUN=path/to/file.mp4 pnpm dev
   *
   * Reports through `window.electron.logging`, not `console`. Preload's
   * console interception patches the console of the *isolated* world, so
   * anything the renderer logs with `console.*` never reaches the main
   * process log -- which makes an unattended check that logs to console
   * indistinguishable from one that never ran.
   */
  useEffect(() => {
    const autorun = import.meta.env.VITE_ENGINE_AUTORUN;
    if (!autorun) {
      return;
    }

    // Status arrives a tick later than mount; wait for it rather than bailing.
    if (!status) {
      return;
    }

    // Say so. A verification path that goes quiet when the thing it verifies is
    // missing is worse than useless -- it looks like a pass.
    if (!status.available) {
      window.electron.logging.error('[engine-autorun] engine unavailable:', status.error);
      return;
    }

    let cancelled = false;

    const run = async () => {
      setVideoPath(autorun);

      const probed = await window.electron.engine.probe(autorun);
      if (!probed.opened) {
        window.electron.logging.error('[engine-autorun] cannot open:', probed.error);
        return;
      }

      const opened = await window.electron.engine.player.open(autorun);
      openRef.current = true;
      setInfo(opened);

      const { warmMs } = await window.electron.engine.player.warm();
      await window.electron.engine.player.play();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await window.electron.engine.player.pause();

      if (cancelled) return;

      const painted = window.electron.engine.frameInfo();
      const inspection = window.electron.engine.inspectFrameSink();
      const playerStats = await window.electron.engine.player.stats();

      window.electron.logging.info(
        '[engine-autorun]',
        JSON.stringify(
          {
            gpu: status.gpu,
            warmMs: Number(warmMs.toFixed(1)),
            painted: painted.painted,
            frame: painted.frame,
            canvas: inspection,
            dropped: playerStats.dropped,
            decoded: playerStats.decoded,
            skippedNoTexture: playerStats.skippedNoTexture,
            skippedRenderError: playerStats.skippedRenderError,
          },
          null,
          2,
        ),
      );
    };

    // A rejection here would otherwise be an unhandled promise: invisible, and
    // indistinguishable from the check having quietly passed.
    run().catch((e: Error) => {
      window.electron.logging.error('[engine-autorun] failed:', e.message);
    });

    return () => {
      cancelled = true;
    };
  }, [status]);

  if (status && !status.available) {
    return (
      <div className="p-8 text-sm">
        <h1 className="text-lg font-semibold mb-2">GPU engine unavailable</h1>
        <p className="text-muted-foreground mb-4">{status.error}</p>
        <pre className="bg-muted rounded p-3 text-xs">pnpm --filter velocity build</pre>
      </div>
    );
  }

  const duration = info?.duration ?? 0;
  const position = scrubbing ? scrubMs : (tick?.currentTime ?? 0);

  return (
    <div className="p-6 flex flex-col gap-4 text-sm max-w-5xl">
      <header>
        <h1 className="text-lg font-semibold">GPU engine harness</h1>
        <p className="text-muted-foreground text-xs">
          velocity {status?.version ?? '...'}
          {status?.gpu ? ` · engine on ${status.gpu.engine}` : ''}
          {status?.gpu && !status.gpu.matched ? ' · ADAPTER MISMATCH' : ''}
        </p>
      </header>

      <div className="flex gap-2">
        <Input
          value={videoPath}
          placeholder="Path to an H.264 file"
          onChange={(e) => setVideoPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void open();
          }}
        />
        <Button onClick={() => void open()} disabled={busy}>
          Open
        </Button>
        <Button variant="secondary" onClick={() => void close()} disabled={!info}>
          Close
        </Button>
      </div>

      {error ? <p className="text-destructive text-xs">{error}</p> : null}

      <canvas
        id={PREVIEW_CANVAS_ID}
        className="w-full bg-black rounded border"
        style={{ aspectRatio: info ? `${info.width} / ${info.height}` : '16 / 9' }}
      />

      <div className="flex items-center gap-2">
        <Button
          onClick={() =>
            void (tick?.playing
              ? window.electron.engine.player.pause()
              : window.electron.engine.player.play())
          }
          disabled={!info}
        >
          {tick?.playing ? 'Pause' : 'Play'}
        </Button>
        <Button
          variant="secondary"
          disabled={!info}
          onClick={() => void seek(position - 5000, true)}
        >
          -5s
        </Button>
        <Button
          variant="secondary"
          disabled={!info}
          onClick={() => void seek(position + 5000, true)}
        >
          +5s
        </Button>

        {[0.5, 1, 2].map((rate) => (
          <Button
            key={rate}
            variant={tick?.rate === rate ? 'default' : 'ghost'}
            disabled={!info}
            onClick={() => void window.electron.engine.player.setRate(rate)}
          >
            {rate}x
          </Button>
        ))}

        <span className="ml-auto tabular-nums text-xs text-muted-foreground">
          {formatMs(position)} / {formatMs(duration)}
        </span>
      </div>

      {/*
        Fast seek while dragging (stops at the keyframe, ~62ms), exact on
        release (decodes forward through the GOP, ~280ms). Doing exact seeks
        during a drag makes the scrubber unusable on long-GOP content.
      */}
      <input
        type="range"
        min={0}
        max={Math.max(duration, 1)}
        value={position}
        disabled={!info}
        onChange={(e) => {
          const ms = Number(e.target.value);
          setScrubbing(true);
          setScrubMs(ms);
          void seek(ms, false);
        }}
        onPointerUp={() => {
          setScrubbing(false);
          void seek(scrubMs, true);
        }}
      />

      <div className="grid grid-cols-3 gap-3">
        {(Object.keys(EFFECT_RANGES) as (keyof Effects)[]).map((key) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="text-xs capitalize text-muted-foreground">
              {key} {effects[key].toFixed(2)}
            </span>
            <input
              type="range"
              {...EFFECT_RANGES[key]}
              value={effects[key]}
              disabled={!info}
              onChange={(e) => void applyEffects({ ...effects, [key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>

      <div className="flex gap-2">
        <Button
          variant="secondary"
          disabled={!info}
          onClick={() => void applyEffects(IDENTITY_EFFECTS)}
        >
          Reset effects
        </Button>
        <Button disabled={!info} onClick={() => void startExport()}>
          Export (same grade)
        </Button>
        <Button variant="ghost" onClick={() => void window.electron.engine.export.cancel()}>
          Cancel export
        </Button>
        <Button variant="ghost" onClick={() => void refreshStats()}>
          Refresh stats
        </Button>
      </div>

      {exportProgress ? (
        <pre className="bg-muted rounded p-3 text-xs overflow-x-auto">
          {`export  ${exportProgress.framesDone}/${exportProgress.framesTotal} frames`}
          {`  ${exportProgress.finished ? 'finished' : 'running'}`}
          {exportProgress.cancelled ? ' (cancelled)' : ''}
          {`\nsteady  ${exportProgress.steadyFps.toFixed(1)} fps   setup ${exportProgress.setupMs.toFixed(0)} ms`}
          {`\nstages  decode ${exportProgress.avgDecodeMs.toFixed(2)} ms  render ${exportProgress.avgRenderMs.toFixed(2)} ms  encode ${exportProgress.avgEncodeMs.toFixed(2)} ms`}
          {exportProgress.error ? `\nerror   ${exportProgress.error}` : ''}
          {exportProgress.output ? `\noutput  ${exportProgress.output}` : ''}
        </pre>
      ) : null}

      {tick ? (
        <pre className="bg-muted rounded p-3 text-xs overflow-x-auto">
          {`queue ${tick.queueDepth}   decoded ${tick.decoded}   dropped ${tick.dropped}`}
          {`   decode ${tick.avgDecodeMs.toFixed(2)} ms`}
          {`\nlast seek ${tick.lastSeekMs.toFixed(0)} ms over ${tick.lastSeekDecoded} frames`}
          {stats
            ? `\nskipped: no-texture ${stats.skippedNoTexture}  render-error ${stats.skippedRenderError}  max queue wait ${stats.maxQueueWaitUs} us`
            : ''}
        </pre>
      ) : null}
    </div>
  );
}

export default EngineHarnessScreen;
