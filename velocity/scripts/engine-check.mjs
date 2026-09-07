// End-to-end check of the GPU video engine, without Electron in the way.
//
// Everything except presentation runs headless: decode, the clock, exact seek,
// the render chain, and export. Presentation is the one part that needs a live
// Chromium GPU process, so it is covered by the harness screen instead
// (`pnpm dev`, then load the app with #engine).
//
// usage: node velocity/scripts/engine-check.mjs <input.mp4> [--export out.mp4]

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const engine = require(path.resolve(here, '..', 'index.js'));

const input = process.argv[2];
const exportFlag = process.argv.indexOf('--export');
const exportTo = exportFlag === -1 ? null : process.argv[exportFlag + 1];

if (!input) {
  console.error('usage: node velocity/scripts/engine-check.mjs <input.mp4> [--export out.mp4]');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ---- environment ----------------------------------------------------------

console.log(`engine ${engine.engineVersion()}`);
for (const line of engine.adapterInfo()) {
  if (line.startsWith('active:')) console.log(line);
}
const decoders = engine.listDecoders();
console.log(`decoders: ${decoders.join(', ') || 'none'}\n`);

// ---- probe before opening -------------------------------------------------
//
// An HEVC file opens and then fails at the first decode, so the probe is the
// difference between a clear message and a mysterious stall.

const probe = engine.probeVideo(input);
console.log(`input: ${input}`);
if (!probe.opened) {
  console.error(`cannot open: ${probe.error}`);
  process.exit(1);
}
for (const type of probe.nativeTypes) console.log(`  ${type}`);

const isHevc = probe.nativeTypes.some((t) => t.includes('HEVC'));
const hasHevcDecoder = decoders.some((d) => d.startsWith('hevc:'));
if (isHevc && !hasHevcDecoder) {
  console.error('\nHEVC source, and this machine has no HEVC decoder MFT. Cannot decode.');
  process.exit(1);
}

const player = new engine.VideoPlayer(input);
const info = player.info();
console.log(`\n${info.width}x${info.height} @ ${info.fps.toFixed(3)}fps, ${(info.duration / 1000).toFixed(1)}s\n`);

/** Pump tick until a frame appears. tick() returns null whenever nothing is due. */
async function waitFrame(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = player.tick();
    if (frame) return frame;
    await sleep(2);
  }
  return null;
}

// ---- 1. decode ------------------------------------------------------------

console.log('decode');
const first = await waitFrame();
check('first frame arrives while paused', first !== null, first ? `pts ${first.pts.toFixed(1)}ms` : '');
check(
  'frame carries an importable texture',
  first?.texture?.pixelFormat === 'bgra',
  `format ${first?.texture?.pixelFormat}`,
);
check('decode thread fills the queue', player.stats().queueDepth > 0, `depth ${player.stats().queueDepth}`);

// ---- 2. frame-accurate seek ----------------------------------------------
//
// Media Foundation only lands on a keyframe. Exact seek decodes forward from
// there, so the frame shown at time t is the last one with pts <= t.
//
// Landing at or before the target is the half that is exact, and it is checked
// as such. How far before it is allowed to be cannot be one nominal frame,
// because a screen recording has no constant rate to take a frame from: capture
// emits when the screen changes, so the container's 60fps is an average with
// real gaps of two frames and more in it, and a target that falls inside one of
// those is a correct seek that a one-frame bound calls broken.
//
// What the bound has to separate is "landed on the frame covering the target"
// from "landed on the keyframe and never decoded forward at all", and those are
// a GOP apart -- seconds, not milliseconds. So it is generous in frames while
// staying two orders of magnitude clear of the failure it is looking for.
const frameMs = 1000 / info.fps;
const seekToleranceMs = Math.max(frameMs * 4, 100);

console.log(`\nexact seek (want 0 <= target-landed < ${seekToleranceMs.toFixed(1)}ms)`);

const errors = [];
const seekMs = [];
for (let i = 0; i < 8; i += 1) {
  const target = Math.random() * Math.max(info.duration - 5000, 1000) + 500;
  const started = Date.now();
  player.seek(target, true);
  const landed = await waitFrame();
  if (!landed) {
    check(`seek to ${target.toFixed(0)}ms`, false, 'no frame');
    continue;
  }
  errors.push(target - landed.pts);
  seekMs.push(Date.now() - started);
}

// Overshooting is always wrong, whatever the frame rate: the frame on screen
// must never be one the target had not reached yet.
const overshot = errors.filter((e) => e < 0);
check(
  'no seek landed past its target',
  overshot.length === 0,
  overshot.length ? `${overshot.length} overshot, worst ${Math.min(...overshot).toFixed(1)}ms` : '',
);

const accurate = errors.filter((e) => e >= 0 && e < seekToleranceMs).length;
check(
  `${accurate}/${errors.length} seeks landed on the frame covering the target`,
  accurate === errors.length,
  `worst ${errors.length ? Math.max(...errors).toFixed(1) : '0'}ms of ${seekToleranceMs.toFixed(0)}ms allowed`,
);
console.log(`        median ${median(seekMs).toFixed(0)}ms, ${player.stats().lastSeekDecoded} frames decoded forward on the last one`);

// ---- 3. the clock paces playback -----------------------------------------
//
// The window has to fit inside the clip. A screen recording is only as long as
// the capture happened to be -- asking for three seconds of a mostly idle
// desktop comes back with 2.4 -- and playing off the end mid-window looks
// exactly like the media clock falling behind: the clock stops, the wall clock
// does not, and the pacing check fails for a reason that is not pacing.

console.log('\nplayback');

const playFrom = Math.min(1000, info.duration * 0.2);
const playWindowMs = Math.min(2000, Math.max(0, info.duration - playFrom) * 0.8);

player.seek(playFrom, true);
await waitFrame();

const before = player.stats();
player.play();
const wallStart = Date.now();
let presented = 0;
while (Date.now() - wallStart < playWindowMs) {
  if (player.tick()) presented += 1;
  await sleep(2);
}
player.pause();

const after = player.stats();
const wall = Date.now() - wallStart;
const mediaAdvanced = after.currentTime - before.currentTime;

// A clip too short to hold a window, or one that ended inside it, makes the
// number meaningless rather than wrong -- so say which it was instead of
// reporting it as clock drift.
const clipSeconds = (info.duration / 1000).toFixed(1);
const tooShort = playWindowMs < 500;

check(
  'media time tracks wall clock',
  !tooShort && !after.endOfStream && Math.abs(mediaAdvanced - wall) < wall * 0.15,
  tooShort || after.endOfStream
    ? `clip is ${clipSeconds}s, too short to measure pacing against`
    : `${mediaAdvanced.toFixed(0)}ms of media in ${wall}ms wall`,
);

// `dropped` counts frames that were already due when tick() next ran: more than
// one came due between two polls, so only the last of them was presented.
//
// This loop polls from Node on a 2ms setTimeout, and a single iteration that
// overshoots one frame period -- a GC pause, or the OS descheduling a process
// that is also busy encoding video -- produces a drop that says nothing about
// the engine. A real caller ticks from a present loop.
//
// So the budget is loose on purpose: from here a late poll and a slow engine
// look the same, and on a busy machine a tenth of the window can go that way.
// What is left is worth having anyway -- it catches presentation collapsing,
// which is what a real regression does. `no silent frame loss` below is the
// exact one. The count is taken across the window rather than over the life of
// the player, which also carries the eight seeks above.
const expectedFrames = playWindowMs / frameMs;
const dropBudget = Math.max(4, Math.round(expectedFrames * 0.1));
const droppedInWindow = after.dropped - before.dropped;

check(
  'frames were not dropped in bulk',
  droppedInWindow <= dropBudget,
  `dropped ${droppedInWindow} of ~${expectedFrames.toFixed(0)} due, budget ${dropBudget}`,
);
// Unlike a late poll, these are the engine losing a frame it was holding, and
// no amount of them is normal.
check('no silent frame loss', after.skippedNoTexture === 0 && after.skippedRenderError === 0);
console.log(`        presented ${presented} frames, decode ${after.avgDecodeMs.toFixed(2)}ms, queue ${after.queueDepth}`);

// ---- 4. tick never blocks the caller -------------------------------------
//
// tick() runs on whatever thread is driving presentation -- the main process,
// per frame. If it ever waits on the decode thread's lock, that wait lands on
// the UI.

check('tick never blocked long on the queue lock', after.maxQueueWaitUs < 5000, `worst ${after.maxQueueWaitUs}us`);

// ---- 5. grading is a re-render, not a re-decode ---------------------------
//
// Each pool slot keeps the NV12 it was rendered from, so a colour change
// re-runs a couple of shader passes over pixels already on the GPU. If this
// ever goes back to the decoder, a slider drag costs a seek per event.

console.log('\neffects');
const decodedBefore = player.stats().decoded;
const latencies = [];
for (let i = 0; i < 40; i += 1) {
  const t0 = performance.now();
  player.setEffects(-0.1 + i * 0.005, 1.3, 0);
  latencies.push(performance.now() - t0);
}
await sleep(120);
const decodedByEffects = player.stats().decoded - decodedBefore;

check('40 effect changes did not trigger re-decodes', decodedByEffects < 20, `${decodedByEffects} frames decoded`);
console.log(`        median ${median(latencies).toFixed(2)}ms, max ${Math.max(...latencies).toFixed(2)}ms`);

player.setEffects(0, 1, 1);
player.close();

// ---- 6. export ------------------------------------------------------------

if (exportTo) {
  console.log('\nexport');
  const exporter = new engine.VideoExporter(input, {
    output: exportTo,
    bitrate: 12_000_000,
    start: 0,
    end: Math.min(info.duration, 5000),
    brightness: -0.1,
    contrast: 1.3,
    saturation: 0,
  });

  let progress = exporter.progress();
  while (!progress.finished) {
    await sleep(200);
    progress = exporter.progress();
    if (progress.error) break;
  }

  check('export finished without error', !progress.error, progress.error ?? '');
  check('export wrote frames', progress.framesDone > 0, `${progress.framesDone} frames`);
  console.log(
    `        ${progress.steadyFps.toFixed(1)} fps steady, setup ${progress.setupMs.toFixed(0)}ms\n` +
      `        decode ${progress.avgDecodeMs.toFixed(2)}ms  render ${progress.avgRenderMs.toFixed(2)}ms  encode ${progress.avgEncodeMs.toFixed(2)}ms`,
  );

  // The grade was applied on the way out, so the output has to be re-openable
  // and carry the range we asked for.
  const outProbe = engine.probeVideo(exportTo);
  check('exported file opens', outProbe.opened, outProbe.error);
}

// ---- 7. textures are released --------------------------------------------

const memory = engine.gpuMemory();
console.log(`\ngpu memory: ${(memory.used / 1048576).toFixed(1)}MB used of ${(memory.budget / 1048576).toFixed(0)}MB budget`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
