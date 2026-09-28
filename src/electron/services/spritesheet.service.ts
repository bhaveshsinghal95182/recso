/**
 * Building the timeline's thumbnail sheets, and keeping them honest.
 *
 * This is the effectful half of the spritesheet story. Every decision about
 * *which* sheets a project needs and *whether* the ones it has are still good
 * lives next door in `spritesheet-plan.ts`, which is pure and tested. This file
 * does the three things that module deliberately cannot: stat the video, call
 * the engine, write the sidecar.
 *
 * The governing constraint is that a sheet is a nicety. A recording opens and
 * plays and exports with no filmstrip at all -- the lane just draws empty. So
 * nothing in here is allowed to throw at a caller who is trying to open a
 * project. Missing addon, missing video, a decode that dies halfway: each one
 * costs that source its thumbnails and nothing else.
 *
 * Sources are generated one after another rather than in parallel. Both go
 * through the same GPU decoder and the same texture budget, and racing them
 * mostly buys contention -- on a two-file recording the second sheet starts
 * a second or two later than it could, which nobody notices, versus two
 * decoders competing for the same hardware, which shows up as stutter in the
 * preview the user is actually watching.
 */

import fs from 'fs';

import { loadVelocityModule } from './engine/native.js';
import type { Project } from '../types/project.types.js';
import type {
  SpritesheetMeta,
  SpritesheetsBySource,
  SpritesheetSource,
} from '../types/spritesheet.types.js';
import * as projectStorage from './project-storage.service.js';
import {
  isSheetStale,
  type SourceStat,
  type SpritesheetTarget,
  spritesheetTargets,
} from './spritesheet-plan.js';

/** What the addon reports about the sheet it just wrote. */
interface EngineSpritesheetResult {
  frameCount: number;
  intervalMs: number;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  totalDurationMs: number;
  imagePath: string;
}

/** The budget knobs. Omitted entirely here -- see `callEngine`. */
interface EngineSpritesheetOptions {
  maxFrames?: number;
  cellWidth?: number;
  maxColumns?: number;
}

type GenerateSpritesheetFn = (
  input: string,
  output: string,
  options?: EngineSpritesheetOptions | null,
) => Promise<EngineSpritesheetResult>;

const SPRITESHEET_SOURCES: readonly SpritesheetSource[] = ['screen', 'webcam'];

/**
 * The addon's sheet generator, or null when this build does not have one.
 *
 * Typed locally rather than added to `EngineBindings` on purpose. That file is
 * a hand-maintained mirror of the napi surface and belongs to whoever changes
 * the napi surface; duplicating the shape here keeps the two edits from
 * colliding. The `typeof === 'function'` probe is required either way -- a
 * velocity built before this export existed loads perfectly well and would
 * otherwise look like a working generator until the first call.
 */
function resolveGenerator(): GenerateSpritesheetFn | null {
  // Not getEngineBindings: that also needs the preview player, and the
  // filmstrip does not -- Linux has the generator before it has the player.
  const candidate = loadVelocityModule()?.generateSpritesheet;
  return typeof candidate === 'function' ? (candidate as GenerateSpritesheetFn) : null;
}

/** Size and mtime of a source video, or null when it is not there to stat. */
function statSource(videoPath: string): SourceStat | null {
  try {
    const stats = fs.statSync(videoPath);
    if (!stats.isFile()) {
      return null;
    }
    return { sizeBytes: stats.size, modifiedMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Turn what the addon returned into a sheet we are willing to store.
 *
 * Every field is checked rather than trusted. A zero or NaN in `columns` or
 * `intervalMs` does not throw anywhere downstream -- `getFrameCoordinates`
 * happily divides by it and hands the renderer coordinates off the edge of the
 * PNG, so the failure surfaces as an inexplicably blank filmstrip rather than
 * as an error. Cheaper to reject it here and regenerate next open.
 *
 * Returns null rather than throwing: the caller treats a malformed result the
 * same way it treats a failed call.
 */
function toMeta(
  raw: EngineSpritesheetResult | null | undefined,
  target: SpritesheetTarget,
  source: SourceStat,
): SpritesheetMeta | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const positive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;

  if (
    !positive(raw.frameCount) ||
    !positive(raw.intervalMs) ||
    !positive(raw.frameWidth) ||
    !positive(raw.frameHeight) ||
    !positive(raw.columns) ||
    !positive(raw.rows)
  ) {
    return null;
  }

  const totalDurationMs =
    typeof raw.totalDurationMs === 'number' && Number.isFinite(raw.totalDurationMs)
      ? Math.max(0, raw.totalDurationMs)
      : null;
  if (totalDurationMs === null) {
    return null;
  }

  // The addon reports where it wrote the PNG; that is authoritative when it is
  // a usable string, and the path we asked for otherwise.
  const imagePath =
    typeof raw.imagePath === 'string' && raw.imagePath.length > 0
      ? raw.imagePath
      : target.imagePath;

  return {
    source: target.source,
    sourceSizeBytes: source.sizeBytes,
    sourceModifiedMs: source.modifiedMs,
    frameCount: raw.frameCount,
    intervalMs: raw.intervalMs,
    frameWidth: raw.frameWidth,
    frameHeight: raw.frameHeight,
    columns: raw.columns,
    rows: raw.rows,
    totalDurationMs,
    imagePath,
  };
}

/** Whether two sheet sets differ enough to be worth writing to disk. */
function sheetsDiffer(a: SpritesheetsBySource, b: SpritesheetsBySource): boolean {
  return SPRITESHEET_SOURCES.some(
    (source) => JSON.stringify(a[source] ?? null) !== JSON.stringify(b[source] ?? null),
  );
}

/**
 * Make sure this project has a current sheet for every source it needs.
 *
 * Fresh sheets are handed back untouched. Stale ones -- and missing ones -- are
 * regenerated if there is something to regenerate from and an addon that can do
 * it. Whatever comes back is written to the `.recso` sidecar and returned.
 *
 * Never rejects. A source that cannot be built is simply absent from the
 * result, which the renderer already has to cope with because sheets arrive
 * after the editor does.
 */
export async function ensureSpritesheets(project: Project): Promise<SpritesheetsBySource> {
  const existing: SpritesheetsBySource = project.spritesheets ?? {};
  const sheets: SpritesheetsBySource = {};

  try {
    const targets = spritesheetTargets(project);
    let generate: GenerateSpritesheetFn | null | undefined;

    for (const target of targets) {
      try {
        const current = existing[target.source] ?? null;
        const source = statSource(target.videoPath);
        const imageExists = fs.existsSync(target.imagePath);

        if (!isSheetStale(current, source, imageExists)) {
          if (current) {
            sheets[target.source] = current;
          }
          continue;
        }

        // Stale with nothing behind it. Not an error -- a recording whose file
        // has been moved or deleted still opens, it just has no filmstrip --
        // and there is nothing to feed the decoder, so do not try.
        if (!source) {
          console.warn(
            `[Spritesheet] ${target.source} source missing, skipping: ${target.videoPath}`,
          );
          continue;
        }

        // Resolved lazily so a project whose sheets are all fresh never touches
        // the addon at all.
        if (generate === undefined) {
          generate = resolveGenerator();
          if (!generate) {
            console.warn(
              '[Spritesheet] velocity has no generateSpritesheet -- ' +
                'timeline thumbnails are unavailable until it is rebuilt',
            );
          }
        }

        if (!generate) {
          continue;
        }

        const started = Date.now();
        const raw = await generate(target.videoPath, target.imagePath);
        const meta = toMeta(raw, target, source);

        if (!meta) {
          console.warn(
            `[Spritesheet] ${target.source} sheet came back malformed, discarding:`,
            raw,
          );
          continue;
        }

        // The addon resolving is not proof it wrote anything. Checking costs
        // one stat and turns "filmstrip is silently blank" into a log line.
        if (!fs.existsSync(meta.imagePath)) {
          console.warn(
            `[Spritesheet] ${target.source} sheet reported but not on disk:`,
            meta.imagePath,
          );
          continue;
        }

        sheets[target.source] = meta;
        console.log(
          `[Spritesheet] Built ${target.source} sheet: ${meta.frameCount} frames ` +
            `(${meta.columns}x${meta.rows}) in ${Date.now() - started}ms`,
        );
      } catch (error) {
        // One source dying must not cost the other its sheet.
        console.error(`[Spritesheet] Failed to build ${target.source} sheet:`, error);
      }
    }
  } catch (error) {
    console.error('[Spritesheet] Failed to plan spritesheets:', error);
  }

  try {
    if (sheetsDiffer(existing, sheets)) {
      projectStorage.saveSpritesheets(project.projectFolderPath, sheets);
    }
  } catch (error) {
    console.error('[Spritesheet] Failed to persist spritesheets:', error);
  }

  return sheets;
}
