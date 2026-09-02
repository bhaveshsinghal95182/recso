// Record -> describe -> open in the engine, with no demux pass anywhere.
//
// This is the whole point of the recorder returning a media info object: every
// number the editor needs is known at capture time, so nothing has to reopen
// the file to find out what is in it.
//
// usage: node velocity/scripts/pipeline-check.mjs [seconds] [outfile]

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const velocity = require(path.resolve(here, '..', 'index.js'));

const seconds = Number(process.argv[2] ?? 4);
const output = path.resolve(process.argv[3] ?? path.join(here, 'pipeline-check.mp4'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}

fs.mkdirSync(path.dirname(output), { recursive: true });

// ---- record ---------------------------------------------------------------

console.log(`recording ${seconds}s of the primary monitor -> ${output}\n`);

const stopper = velocity.startMonitorRecordingV2({
  outputPath: output,
  bitrate: 8_000_000,
  includeSystemAudio: false,
  targetFps: 60,
  enableWebcam: false,
});

await sleep(seconds * 1000);

// stop() now reports what it wrote, one entry per capture it owned.
const infos = stopper.stop();

console.log('recorder reported:');
console.log(JSON.stringify(infos, null, 2));
console.log();

console.log('recorder');
check('stop reported a recording', infos.length > 0);

const screen = infos.find((info) => info.role === 'screen');
check('a screen capture is present', Boolean(screen));

if (!screen) {
  process.exit(1);
}

check('recording is usable', screen.usable);
check('geometry was captured', screen.width > 0 && screen.height > 0, `${screen.width}x${screen.height}`);
check('frames were written', screen.frames > 0, `${screen.frames} frames`);
check('codec is h264', screen.codec === 'h264', screen.codec);
check(
  'audio correctly reported absent',
  screen.hasAudio === false,
  'recorded with includeSystemAudio: false',
);
check('file has bytes', screen.fileSize > 0, `${(screen.fileSize / 1048576).toFixed(1)} MB`);

// Measured rate, not the nominal one. Screen capture only delivers a frame when
// something changes, so on a quiet desktop this is legitimately well under the
// target -- the point is that it is now knowable at all.
check(
  'fps was measured, not assumed',
  screen.fps > 0 && screen.fps <= screen.configuredFps + 1,
  `${screen.fps.toFixed(2)} measured vs ${screen.configuredFps} requested`,
);

// ---- cross-check against Media Foundation ---------------------------------
//
// The recorder's numbers should agree with what the engine independently reads
// out of the finished file. Where they disagree, the recorder is the one to
// trust: it counted frames, the container reports a nominal rate.

console.log('\nengine');

const probe = velocity.probeVideo(output);
check('engine can open the recording', probe.opened, probe.error);
for (const type of probe.nativeTypes) console.log(`        ${type}`);
check(
  'recording is H.264, not HEVC',
  probe.nativeTypes.some((t) => t.includes('H264')),
);

const player = new velocity.VideoPlayer(output);
const info = player.info();

check(
  'engine geometry matches the recorder',
  info.width === screen.width && info.height === screen.height,
  `engine ${info.width}x${info.height} vs recorder ${screen.width}x${screen.height}`,
);

// These two are not the same measurement and do not converge.
//
// The recorder times wall clock from its first frame to the stop signal. The
// container's timeline starts wherever Media Foundation put sample zero and
// ends after whatever duration it assigned the last sample. Each end carries
// its own slop -- capture startup latency, the encoder's timeline base, the
// tail sample -- and none of it is observable from the other side.
//
// Measured across runs the delta ranged +658ms to -518ms with no relationship
// to frame rate (it was -402ms at 12fps, where a frame is 81ms), so this is a
// few hundred ms of independent slop, not a frame-granularity effect. Asserting
// tight agreement would be asserting something that is not true of the system.
//
// What is worth checking is that they describe the same recording at all: same
// order of magnitude, no factor-of-two error from a units or timebase mistake.
const durationDeltaMs = screen.durationMs - info.duration;
const durationRatio = info.duration > 0 ? screen.durationMs / info.duration : 0;

check('both durations are real', info.duration > 0 && screen.durationMs > 0);
check(
  'durations describe the same recording',
  durationRatio > 0.75 && durationRatio < 1.35,
  `capture ${screen.durationMs.toFixed(0)}ms vs container ${info.duration.toFixed(0)}ms ` +
    `(delta ${durationDeltaMs.toFixed(0)}ms, ratio ${durationRatio.toFixed(2)})`,
);

console.log(
  `        container fps ${info.fps.toFixed(3)}  ·  measured fps ${screen.fps.toFixed(3)}` +
    `  <- the container rate is nominal; capture is variable-rate`,
);

// ---- decode ---------------------------------------------------------------

async function waitFrame(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = player.tick();
    if (frame) return frame;
    await sleep(2);
  }
  return null;
}

const first = await waitFrame();
check('first frame decodes', first !== null, first ? `pts ${first.pts.toFixed(1)}ms` : '');
check('frame is presentable', first?.texture?.pixelFormat === 'bgra', first?.texture?.pixelFormat);

// Seek using the recorder's duration rather than the container's.
const target = screen.durationMs * 0.5;
player.seek(target, true);
const seeked = await waitFrame();
check(
  'seek to the recorder-reported midpoint lands',
  seeked !== null && Math.abs(target - seeked.pts) < 250,
  seeked ? `target ${target.toFixed(0)}ms -> ${seeked.pts.toFixed(0)}ms` : 'no frame',
);

player.close();

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
