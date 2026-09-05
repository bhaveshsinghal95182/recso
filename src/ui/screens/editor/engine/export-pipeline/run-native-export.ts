/**
 * Export through the engine.
 *
 * The difference from `runEngineCanvasExport` is not speed, it is where the
 * bytes live. That path fetches the whole recording into a `Blob`, decodes it
 * frame by frame in the renderer, composites onto a canvas, muxes with
 * mediabunny, and hands back an `ArrayBuffer` for the main process to write --
 * so a recording has to fit in renderer memory twice over. A five gigabyte take
 * does not fit once.
 *
 * Here the renderer sends a description and a path. The engine opens the file
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
import { resolveStartDelayCompensationSeconds } from './audio-mix';
import type { ExportPlan } from './plan';
import { createProgressSnapshot } from './progress';
import { resolveProjectAudioSidecarPaths, toFileUrl } from './source-paths';
import type { EngineCanvasExportOptions, EngineCanvasExportResult } from './types';

/** How often to ask the engine where it has got to. */
const POLL_MS = 200;

/** Bitrate for a given output size and quality, matching the canvas path. */
function resolveBitrate(width: number, height: number, quality: string | undefined): number {
  // Roughly 0.1 bits per pixel per frame at 30fps for "high", which lands near
  // 12Mbit for 1080p -- the same ballpark the canvas exporter targets.
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
 * Durations are probed with mediabunny, which is safe here in a way it is not
 * for the video: these are a few megabytes of audio, not the recording.
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

  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny');
  const sources: EngineAudioSource[] = [];

  for (const candidate of present) {
    if (!candidate.compensateStartDelay) {
      sources.push({ path: candidate.path });
      continue;
    }

    let offsetMs = 0;
    try {
      const response = await fetch(toFileUrl(candidate.path));
      if (response.ok || response.status === 0) {
        const input = new Input({
          source: new BlobSource(await response.blob()),
          formats: ALL_FORMATS,
        });
        const track = await input.getPrimaryAudioTrack();
        const durationSeconds = track ? await track.computeDuration() : 0;
        if (durationSeconds > 0) {
          offsetMs =
            resolveStartDelayCompensationSeconds(sourceDurationMs / 1000, durationSeconds) * 1000;
        }
      }
    } catch {
      // A sidecar that will not open is one the canvas path would have skipped
      // too. Mixing it unshifted is closer to right than dropping it.
    }

    sources.push({ path: candidate.path, offsetMs: offsetMs || undefined });
  }

  return sources;
}

export interface NativeExportOptions extends Pick<
  EngineCanvasExportOptions,
  'project' | 'config' | 'onProgress' | 'onCancelReady'
> {
  /** Where the engine should write. Resolved by the caller, not invented here. */
  outputPath: string;
  /** Built once by `planExport`, so both runners see the same composition. */
  plan: ExportPlan;
}

export interface NativeExportResult extends Omit<EngineCanvasExportResult, 'buffer' | 'fileSize'> {
  /** The file the engine wrote. Already on disk. */
  outputPath: string;
}

export async function runNativeExport({
  project,
  config,
  plan,
  outputPath,
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
    cursor: resolved.cursor?.image ?? undefined,
    cursorImages: resolved.cursor?.images,
    cursorTrack: resolved.cursor?.track,
    cursorSize: resolved.cursor?.sizePx,
    cursorEffects: resolved.cursor?.effects,
    audioSources,
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
        onProgress?.(
          createProgressSnapshot(progress.framesDone / total, total, startedAt, 'export'),
        );

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
