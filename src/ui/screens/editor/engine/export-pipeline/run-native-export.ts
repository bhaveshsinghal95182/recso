/**
 * Export through the engine.
 *
 * The renderer sends a composition description and a path. The engine opens the file
 * with Media Foundation, which streams it, composites on the GPU, encodes, and
 * writes the output itself. Nothing crosses into the renderer except progress
 * numbers, so the size of the recording stops mattering.
 *
 * What the renderer still does is resolve the composition -- layout, cursor
 * bitmaps, background raster -- because that is all small, and because doing it
 * anywhere else would mean two implementations of the layout rules.
 */

import type { EngineExportOptions } from '@/electron.js';
import type { EngineAudioSource } from '@/electron.js';
import type { Project } from '@/types';

import { resolveComposition } from '../gpu-preview/config-to-engine';
import { resolveStartDelayCompensationSeconds } from './audio-timing';
import type { ExportPlan } from './plan';
import { createProgressSnapshot } from './progress';
import { resolveProjectAudioSidecarPaths } from './source-paths';
import type { ExportRequestOptions } from './types';

/** How often to ask the engine where it has got to. */
const POLL_MS = 200;

/** Bitrate for a given output size and quality, matching the canvas path. */
function resolveBitrate(width: number, height: number, quality: string | undefined): number {
  // Roughly 0.1 bits per pixel per frame at 30fps for "high", which lands near
  // 12Mbit for 1080p keeps the existing quality profile users expect.
  const pixels = Math.max(1, width * height);
  const perPixel = quality === 'low' ? 0.05 : quality === 'medium' ? 0.075 : 0.1;
  return Math.round(Math.min(80_000_000, Math.max(2_000_000, pixels * perPixel * 30)));
}

/**
 * Every file contributing sound, with the shift each one needs.
 *
 * The recording itself comes first now. When the native recorder captures the
 * system audio and the microphone, it writes them into the video's own track --
 * so the sound is already in the file, already on the picture's clock, and there
 * is nothing to shift. Older recordings have no audio there and the engine skips
 * a source it cannot decode, so listing it always is safe either way.
 *
 * The sidecars are still read for recordings made before that, or on a platform
 * where native audio is not available. They only exist when the renderer
 * recorded them, so anything missing is dropped rather than handed to the engine
 * as a path that is not there.
 *
 * Durations are probed by the same native Media Foundation layer that will
 * decode them for export. That keeps the renderer out of media demuxing and
 * means the old canvas exporter is not retained just to inspect a sidecar.
 */
async function resolveAudioSources(
  project: Project,
  webcamSourcePath: string | undefined,
  sourceDurationMs: number,
): Promise<EngineAudioSource[]> {
  const { desktopAudioPath, micPath } = resolveProjectAudioSidecarPaths(project);

  const candidates: Array<{ path: string | undefined; compensateStartDelay: boolean }> = [
    // Whatever the native recorder laid down against the picture. No shift:
    // it was written frame by frame alongside the video it belongs to.
    { path: project.rawVideoPath, compensateStartDelay: false },
    { path: desktopAudioPath, compensateStartDelay: true },
    { path: micPath, compensateStartDelay: true },
    // The camera sidecar carries the camera's microphone, and it stays locked
    // to the camera footage -- which is composited without compensation.
    { path: webcamSourcePath, compensateStartDelay: false },
  ];

  const named = candidates.filter(
    (candidate): candidate is { path: string; compensateStartDelay: boolean } =>
      Boolean(candidate.path),
  );

  const present: typeof named = [];
  for (const candidate of named) {
    if ((await window.electron.exporter.fileSize(candidate.path)) > 0) {
      present.push(candidate);
    }
  }

  if (present.length === 0) {
    return [];
  }

  const sources: EngineAudioSource[] = [];

  for (const candidate of present) {
    if (!candidate.compensateStartDelay) {
      sources.push({ path: candidate.path });
      continue;
    }

    let probe: Awaited<ReturnType<typeof window.electron.engine.probeAudio>>;
    try {
      probe = await window.electron.engine.probeAudio(candidate.path);
    } catch {
      // Legacy and crash-recovered projects can contain an incomplete sidecar.
      // A bad optional audio file should not make an otherwise valid video
      // impossible to export.
      continue;
    }

    if (!probe.hasAudio || probe.duration <= 0) {
      continue;
    }

    const offsetMs =
      resolveStartDelayCompensationSeconds(sourceDurationMs / 1000, probe.duration / 1000) * 1000;

    sources.push({ path: candidate.path, offsetMs: offsetMs || undefined });
  }

  return sources;
}

export interface NativeExportOptions extends Pick<
  ExportRequestOptions,
  'project' | 'config' | 'onProgress' | 'onCancelReady'
> {
  /** Where the engine should write. Resolved by the caller, not invented here. */
  outputPath: string;
  /** Built once by `planExport`, so both runners see the same composition. */
  plan: ExportPlan;
  /** Unset leaves the choice to the engine ("auto"). */
  encoder?: 'auto' | 'hardware' | 'software';
}

export interface NativeExportResult {
  /** The file the engine wrote. Already on disk. */
  outputPath: string;
  durationSeconds: number;
}

export async function runNativeExport({
  project,
  config,
  plan,
  outputPath,
  encoder,
  onProgress,
  onCancelReady,
}: NativeExportOptions): Promise<NativeExportResult> {
  const sourcePath = project.rawVideoPath;
  if (!sourcePath) {
    throw new Error('Source video path is missing');
  }

  let cancelled = false;
  onCancelReady?.(() => {
    cancelled = true;
    void window.electron.engine.export.cancel();
  });

  const { output, composition, webcamSourcePath, compositionDurationMs } = plan;

  // The same resolver the preview runs, so what gets encoded is what was on
  // screen when the user pressed export.
  const resolved = await resolveComposition(
    composition,
    { width: output.width, height: output.height },
    project,
  );

  const audioSources = await resolveAudioSources(project, webcamSourcePath, plan.sourceDurationMs);

  const options: EngineExportOptions = {
    output: outputPath,
    bitrate: resolveBitrate(output.width, output.height, config.quality),
    canvasWidth: output.width,
    canvasHeight: output.height,
    layout: resolved.layout,
    background: resolved.background,
    crop: resolved.crop ?? undefined,
    webcamPath: resolved.webcam.width > 0 ? webcamSourcePath : undefined,
    webcam: resolved.webcam.width > 0 ? resolved.webcam : undefined,
    zoomRegions: resolved.zoomRegions,
    cuts: resolved.cuts,
    webcamCuts: resolved.webcamCuts,
    layerOrder: resolved.layerOrder,
    webcamZoomRegions: resolved.webcamZoomRegions,
    cursor: resolved.cursor?.image ?? undefined,
    cursorImages: resolved.cursor?.images,
    cursorTrack: resolved.cursor?.track,
    cursorSize: resolved.cursor?.sizePx,
    cursorEffects: resolved.cursor?.effects,
    audioSources,
    ...(encoder ? { encoder } : {}),
  };

  const startedAt = performance.now();
  await window.electron.engine.export.start(sourcePath, options);

  // The engine runs on its own thread and reports its own progress; there is
  // nothing to drive from here, only something to watch.
  await new Promise<void>((resolve, reject) => {
    const timer = window.setInterval(() => {
      void (async () => {
        let progress;
        try {
          progress = await window.electron.engine.export.progress();
        } catch (error) {
          window.clearInterval(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        if (!progress) {
          window.clearInterval(timer);
          reject(new Error('The engine export stopped reporting progress'));
          return;
        }

        const total = Math.max(1, progress.framesTotal);
        onProgress?.({
          ...createProgressSnapshot(progress.framesDone / total, total, startedAt, 'export'),
          ...(progress.encoder ? { encoder: progress.encoder } : {}),
        });

        if (progress.error) {
          window.clearInterval(timer);
          reject(new Error(progress.error));
          return;
        }

        if (progress.cancelled || cancelled) {
          window.clearInterval(timer);
          reject(new Error('Export cancelled'));
          return;
        }

        if (progress.finished) {
          window.clearInterval(timer);
          resolve();
        }
      })();
    }, POLL_MS);
  });

  return {
    outputPath,
    durationSeconds: compositionDurationMs / 1000,
  };
}
