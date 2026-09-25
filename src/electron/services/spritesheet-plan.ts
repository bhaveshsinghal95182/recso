/**
 * Which spritesheets a project needs, and whether the ones it has are still good.
 *
 * Pure decisions only — no filesystem, no engine. The caller stats the files
 * and calls the addon; this module just says what to do about what it found.
 * That split is deliberate: deciding to regenerate a sheet is cheap to get
 * wrong and expensive to notice, because a stale sheet is not an error, it is
 * a timeline quietly showing thumbnails of the wrong footage.
 */

import path from 'path';

import type { SpritesheetMeta, SpritesheetSource } from '../types/spritesheet.types.js';

/** One sheet to build: which video it comes from and where the PNG goes. */
export interface SpritesheetTarget {
  source: SpritesheetSource;
  videoPath: string;
  imagePath: string;
}

/**
 * The parts of a project that decide which sheets it needs.
 *
 * Narrower than `Project` on purpose — this is the whole input, so a test does
 * not have to build a fifty-field project to ask a two-field question.
 */
export interface SpritesheetProject {
  projectFolderPath: string;
  rawVideoPath: string;
  webcamOverlay?: { sourcePath?: string | null } | null;
}

/** Size and mtime of a source video, as `fs.statSync` reports them. */
export interface SourceStat {
  sizeBytes: number;
  modifiedMs: number;
}

/** `spritesheet-screen.png`, `spritesheet-webcam.png`. */
export function spritesheetImageName(source: SpritesheetSource): string {
  return `spritesheet-${source}.png`;
}

/**
 * The sheets this project should have.
 *
 * Screen always; webcam only when the recording actually has a camera sidecar.
 * A project whose camera is currently toggled off still gets a webcam sheet —
 * the lane appears the moment it is toggled back on, and generating it then
 * would mean an empty filmstrip for however long the decode takes.
 */
export function spritesheetTargets(project: SpritesheetProject): SpritesheetTarget[] {
  const targets: SpritesheetTarget[] = [
    {
      source: 'screen',
      videoPath: project.rawVideoPath,
      imagePath: path.join(project.projectFolderPath, spritesheetImageName('screen')),
    },
  ];

  const webcamPath = project.webcamOverlay?.sourcePath;
  if (webcamPath) {
    targets.push({
      source: 'webcam',
      videoPath: webcamPath,
      imagePath: path.join(project.projectFolderPath, spritesheetImageName('webcam')),
    });
  }

  return targets;
}

/**
 * Whether a sheet has to be rebuilt.
 *
 * `source` is null when the video is missing. That is not a reason to
 * regenerate — there is nothing to regenerate from — so the sheet we already
 * have is kept and drawn.
 */
export function isSheetStale(
  meta: SpritesheetMeta | null,
  source: SourceStat | null,
  imageExists: boolean,
): boolean {
  if (!imageExists) return true;
  if (meta === null) return true;
  if (source === null) return false;
  if (meta.sourceSizeBytes === undefined || meta.sourceModifiedMs === undefined) return true;

  return meta.sourceSizeBytes !== source.sizeBytes || meta.sourceModifiedMs !== source.modifiedMs;
}
