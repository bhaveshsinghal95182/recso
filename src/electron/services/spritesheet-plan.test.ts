import path from 'path';
import { describe, expect, it } from 'vitest';

import type { SpritesheetMeta } from './../types/spritesheet.types.js';
import {
  isSheetStale,
  type SourceStat,
  type SpritesheetProject,
  spritesheetTargets,
} from './spritesheet-plan.js';

const PROJECT_FOLDER = path.join('C:', 'recordings', 'take-1', '.recso');
const SCREEN_VIDEO = path.join('C:', 'recordings', 'take-1', 'raw.mp4');
const WEBCAM_VIDEO = path.join('C:', 'recordings', 'take-1', 'raw_camera.mp4');

function project(overrides: Partial<SpritesheetProject> = {}): SpritesheetProject {
  return {
    projectFolderPath: PROJECT_FOLDER,
    rawVideoPath: SCREEN_VIDEO,
    ...overrides,
  };
}

function meta(overrides: Partial<SpritesheetMeta> = {}): SpritesheetMeta {
  return {
    source: 'screen',
    sourceSizeBytes: 4_000_000,
    sourceModifiedMs: 1_700_000_000_000,
    frameCount: 60,
    intervalMs: 1000,
    frameWidth: 160,
    frameHeight: 90,
    columns: 10,
    rows: 6,
    totalDurationMs: 60_000,
    imagePath: path.join(PROJECT_FOLDER, 'spritesheet-screen.png'),
    ...overrides,
  };
}

const FRESH: SourceStat = { sizeBytes: 4_000_000, modifiedMs: 1_700_000_000_000 };

describe('spritesheetTargets', () => {
  it('always wants a sheet for the screen recording', () => {
    const targets = spritesheetTargets(project());

    expect(targets).toHaveLength(1);
    expect(targets[0].source).toBe('screen');
    expect(targets[0].videoPath).toBe(SCREEN_VIDEO);
  });

  it('wants a second sheet when the recording has a camera sidecar', () => {
    const targets = spritesheetTargets(project({ webcamOverlay: { sourcePath: WEBCAM_VIDEO } }));

    expect(targets.map((target) => target.source)).toEqual(['screen', 'webcam']);
    expect(targets[1].videoPath).toBe(WEBCAM_VIDEO);
  });

  it('wants the webcam sheet even while the overlay is switched off', () => {
    // The overlay defaults to disabled and the user flips it on in the editor.
    // Waiting for that to start the decode means an empty webcam lane for as
    // long as the decode takes, which reads as a broken feature.
    const targets = spritesheetTargets(project({ webcamOverlay: { sourcePath: WEBCAM_VIDEO } }));

    expect(targets).toHaveLength(2);
  });

  it('skips the webcam sheet when there is no camera track', () => {
    expect(spritesheetTargets(project({ webcamOverlay: null }))).toHaveLength(1);
    expect(spritesheetTargets(project({ webcamOverlay: undefined }))).toHaveLength(1);
    expect(spritesheetTargets(project({ webcamOverlay: { sourcePath: null } }))).toHaveLength(1);
    expect(spritesheetTargets(project({ webcamOverlay: { sourcePath: '' } }))).toHaveLength(1);
  });

  it('names each sheet after its source and puts it in the project folder', () => {
    const targets = spritesheetTargets(project({ webcamOverlay: { sourcePath: WEBCAM_VIDEO } }));

    expect(targets.map((target) => path.basename(target.imagePath))).toEqual([
      'spritesheet-screen.png',
      'spritesheet-webcam.png',
    ]);
    for (const target of targets) {
      expect(path.dirname(target.imagePath)).toBe(PROJECT_FOLDER);
    }
  });

  it('gives the two sheets different files', () => {
    // One shared filename would have the camera sheet overwrite the screen one
    // and both lanes would draw the camera.
    const [screen, webcam] = spritesheetTargets(
      project({ webcamOverlay: { sourcePath: WEBCAM_VIDEO } }),
    );

    expect(screen.imagePath).not.toBe(webcam.imagePath);
  });
});

describe('isSheetStale', () => {
  it('is stale when there is no sheet yet', () => {
    expect(isSheetStale(null, FRESH, false)).toBe(true);
  });

  it('is fresh when the metadata matches the video on disk', () => {
    expect(isSheetStale(meta(), FRESH, true)).toBe(false);
  });

  it('is stale when the video has been rewritten at a different size', () => {
    expect(isSheetStale(meta(), { ...FRESH, sizeBytes: 9_000_000 }, true)).toBe(true);
  });

  it('is stale when the video has been rewritten at the same size', () => {
    // A re-mux after a crash recovery can land on the same byte count. The
    // mtime is the only thing that catches it.
    expect(isSheetStale(meta(), { ...FRESH, modifiedMs: 1_700_000_999_999 }, true)).toBe(true);
  });

  it('is stale when the metadata survived but the PNG did not', () => {
    // Someone cleared the .recso folder, or the write failed halfway.
    expect(isSheetStale(meta(), FRESH, false)).toBe(true);
  });

  it('is stale when the metadata predates source tracking', () => {
    // project.json written before this feature existed has no size or mtime
    // recorded, so there is no way to tell whether it still matches.
    const legacy = meta();
    delete (legacy as Partial<SpritesheetMeta>).sourceSizeBytes;
    delete (legacy as Partial<SpritesheetMeta>).sourceModifiedMs;

    expect(isSheetStale(legacy, FRESH, true)).toBe(true);
  });

  it('keeps the sheet it has when the video has gone missing', () => {
    // Nothing to regenerate from. Rebuilding would fail and throw away a
    // perfectly good filmstrip on the way.
    expect(isSheetStale(meta(), null, true)).toBe(false);
  });

  it('is stale when the video is missing and so is the sheet', () => {
    expect(isSheetStale(meta(), null, false)).toBe(true);
  });
});
