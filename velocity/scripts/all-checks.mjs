// Every native engine check, in one run.
//
// These are integration checks, not unit tests: each one drives the real
// recorder, the real decoder and the real GPU render chain, and several capture
// the actual screen, camera and system audio. So they run one at a time --
// parallel runs would fight over the same hardware -- and the whole suite takes
// a couple of minutes.
//
// Two things a plain `a && b && c` chain could not do, which is why this is a
// script:
//
//   * `engine-check.mjs` needs a source file. Nothing else here takes an
//     argument, so it was the one check you could not run without first going
//     and finding an mp4. It reads what `pipeline-check.mjs` records.
//
//   * A failing check should not hide the ones behind it. Everything runs, and
//     the summary at the end says what broke.
//
// usage: node velocity/scripts/all-checks.mjs [recordSeconds]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const velocity = require(path.resolve(here, '..', 'index.js'));
const recordSeconds = Number(process.argv[2] ?? 4);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-all-checks-'));
const sourceClip = path.join(workDir, 'source.mp4');

/** Below this there is not enough timeline for `engine` to seek around in. */
const USABLE_CLIP_MS = 1500;

/**
 * The clip `engine` reads, which is not always the one `pipeline` just recorded.
 *
 * Windows delivers a frame only when the screen changes, so a desktop that sat
 * still through the capture produces one frame and a 33ms file. There is
 * nothing in that for `engine-check` to work with -- no timeline to seek around
 * and none to pace playback against -- and failing it would be reporting the
 * idle screen as an engine defect. `PatternEncoder` writes a fixed number of
 * frames at a fixed rate, which is the same reason `cuts-check` uses it.
 *
 * The recording is still preferred when there is one worth having, because it
 * is the only place the engine meets real capture output.
 */
function engineSource() {
  let recordedMs = 0;
  try {
    const player = new velocity.VideoPlayer(sourceClip);
    recordedMs = player.info().duration;
    player.close();
  } catch {
    recordedMs = 0;
  }

  if (recordedMs >= USABLE_CLIP_MS) {
    return { clip: sourceClip, note: `the ${(recordedMs / 1000).toFixed(1)}s clip pipeline recorded` };
  }

  const FPS = 30;
  const synthetic = path.join(workDir, 'pattern.mp4');
  const encoder = new velocity.PatternEncoder(synthetic, 1280, 720, FPS, 4_000_000);
  for (let i = 0; i < FPS * 6; i += 1) encoder.writeFrame();
  encoder.finish();

  return {
    clip: synthetic,
    note: `a synthetic 6s clip -- the screen only moved enough for ${(recordedMs / 1000).toFixed(1)}s`,
  };
}

// Cheapest first, so an obviously broken engine fails in seconds rather than
// after two minutes of recording. `pipeline` has to come before `engine`: it is
// what produces the clip `engine` reads.
const checks = [
  { name: 'cuts', script: 'cuts-check.mjs', args: [], note: 'synthetic clip, no capture' },
  {
    name: 'pipeline',
    script: 'pipeline-check.mjs',
    args: [String(recordSeconds), sourceClip],
    note: `records ${recordSeconds}s of the primary monitor`,
  },
  {
    name: 'engine',
    script: 'engine-check.mjs',
    needs: 'pipeline',
    note: 'decode, seek, render and export the recorded clip',
    // Resolved after `pipeline` has run, because what it managed to record is
    // what decides whether `engine` reads the recording or a synthetic clip.
    resolve: () => {
      const { clip, note } = engineSource();
      return { args: [clip, '--export', path.join(workDir, 'engine-export.mp4')], note };
    },
  },
  {
    name: 'spritesheet',
    script: 'spritesheet-check.mjs',
    args: [String(recordSeconds)],
    // Records its own source rather than reading `sourceClip`: the sheet's
    // geometry comes from the file's duration, and it falls back to a synthetic
    // clip on its own when the desktop sat still.
    note: 'builds a timeline filmstrip and reads its pixels back',
  },
  { name: 'composition', script: 'composition-check.mjs', args: [], note: 'needs a camera' },
  {
    name: 'export-composition',
    script: 'export-composition-check.mjs',
    args: [],
    note: 'needs a camera',
  },
  { name: 'audio', script: 'audio-check.mjs', args: [], note: 'needs system audio' },
];

function run(check) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, check.script), ...check.args], {
      stdio: 'inherit',
    });

    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const results = [];

for (const check of checks) {
  // A check whose input never got produced has not failed -- it never ran. Say
  // so, rather than reporting a second failure for one broken thing.
  const blockedBy = results.find((r) => r.name === check.needs && r.status !== 'pass');
  if (blockedBy) {
    console.log(`\n=== ${check.name} -- skipped, ${blockedBy.name} did not pass ===`);
    results.push({ name: check.name, status: 'skip', ms: 0 });
    continue;
  }

  if (check.resolve) Object.assign(check, check.resolve());

  console.log(`\n=== ${check.name} -- ${check.note} ===`);
  const startedAt = Date.now();
  const code = await run(check);
  results.push({ name: check.name, status: code === 0 ? 'pass' : 'fail', ms: Date.now() - startedAt });
}

fs.rmSync(workDir, { recursive: true, force: true });

const label = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };
const width = Math.max(...results.map((r) => r.name.length));

console.log('\n--- engine checks ---');
for (const result of results) {
  const seconds = result.status === 'skip' ? '' : `${(result.ms / 1000).toFixed(1)}s`;
  console.log(`  ${label[result.status]}  ${result.name.padEnd(width)}  ${seconds}`);
}

const failed = results.filter((r) => r.status === 'fail').length;
const skipped = results.filter((r) => r.status === 'skip').length;
const total = (results.reduce((sum, r) => sum + r.ms, 0) / 1000).toFixed(1);

console.log(
  `\n${results.length - failed - skipped} passed, ${failed} failed` +
    `${skipped ? `, ${skipped} skipped` : ''}  (${total}s)`,
);

process.exit(failed > 0 ? 1 : 0);
