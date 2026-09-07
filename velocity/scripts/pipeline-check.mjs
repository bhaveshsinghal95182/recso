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
// The slop is absolute, not proportional, so a ratio is the wrong shape for it:
// the same few hundred ms that is nothing across a minute is a third of a two
// second clip. Worse, on a quiet desktop there is nothing to take a ratio of.
// Windows delivers a frame only when the screen changes, so a static desktop
// hands the encoder a single frame and the file is legitimately 33ms long for
// a two second capture -- which is the whole reason `duration_ms` is measured
// on the wall clock instead of read out of the stream.
//
// So the container being shorter than the capture is not a defect, and the two
// things that would be are checked instead: a container claiming time that was
// never captured, and frames that do not fit the timeline holding them.
// Positive means the container claims time the capture never ran for, which is
// the direction that indicates a bug. Negative is just a screen that sat still.
const overshootMs = info.duration - screen.durationMs;

// One tail sample at the rate capture actually ran, capped so a near-static
// screen does not buy an unlimited budget.
const tailMs = screen.fps > 0 ? Math.min(1000, 1000 / screen.fps) : 0;
const slopMs = 900 + tailMs;

check('both durations are real', info.duration > 0 && screen.durationMs > 0);
check(
  'the container claims no more time than was captured',
  overshootMs <= slopMs,
  `container ${info.duration.toFixed(0)}ms vs capture ${screen.durationMs.toFixed(0)}ms ` +
    `(over by ${overshootMs.toFixed(0)}ms of ${slopMs.toFixed(0)}ms allowed)`,
);

// The other half of the old ratio check, and the half a static screen cannot
// fake: however few frames capture produced, they have to fit the container's
// timeline at a rate capture could have produced them at. A seconds/ms mix-up
// on the timebase makes the container 1000x too short, which shows up here as
// an impossible frame rate rather than as a plausibly quiet desktop.
const containerFps = info.duration > 0 ? screen.frames / (info.duration / 1000) : Infinity;
check(
  'the frames fit the container timeline',
  containerFps <= screen.configuredFps * 1.5 + 1,
  `${screen.frames} frame(s) over ${info.duration.toFixed(0)}ms is ${containerFps.toFixed(1)}fps, ` +
    `captured at up to ${screen.configuredFps}`,
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

// Seek using the recorder's duration rather than the container's, because that
// is the number the editor puts on its timeline.
//
// A seek lands on the frame covering the target, and on a variable-rate capture
// that frame can have started a long way before it -- half a second on a quiet
// desktop, and the whole recording when the screen never changed and there is
// a single frame to land on. So the target is clamped to what the file actually
// holds, and the tolerance carries one frame at the rate capture really ran
// rather than at the container's nominal one.
const target = screen.durationMs * 0.5;
const reachable = Math.min(target, info.duration);
const captureFrameMs = screen.fps > 0 ? 1000 / screen.fps : 0;

player.seek(target, true);
const seeked = await waitFrame();
check(
  'seek to the recorder-reported midpoint lands',
  seeked !== null && Math.abs(reachable - seeked.pts) < 250 + captureFrameMs,
  seeked
    ? `target ${target.toFixed(0)}ms -> ${seeked.pts.toFixed(0)}ms` +
        (reachable < target ? ` (clamped to the ${info.duration.toFixed(0)}ms the file holds)` : '')
    : 'no frame',
);

player.close();

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
