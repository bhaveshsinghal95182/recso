// A frame posted from a phone should come out the other end as the camera
// track of a real recording.
//
// This is the check that matters. The pairing server can be perfect and the
// recording still not contain the phone, because that depends on the native
// sidecar loop actually reading the network frame slot -- so this drives the
// whole chain: post frames over HTTPS with a token, record for a few seconds
// with `webcamSource: 'phone'`, then open the sidecar the recorder wrote and
// look at the pixels in it.
//
// The frames are a flat, unmistakable colour. Screen content never produces it,
// so finding it in the camera track proves the picture came from the phone
// rather than from a webcam that happened to be attached.
//
// usage: node scripts/phone-camera-recording-check.mjs <dist-electron> [seconds]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The certificate is self-signed by design; the pairing check verifies its
// contents properly, and this one only needs to get bytes through it.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const load = (p) => import(pathToFileURL(path.resolve(p)).href);

const build = process.argv[2] ?? 'dist-electron';
const seconds = Number(process.argv[3] ?? 4);

const service = await load(path.join(build, 'services/phone-camera.service.js'));
const sharp = (await load('node_modules/sharp/lib/index.js')).default;
const loaded = await load('velocity/index.js');
const velocity = loaded.phoneCameraStatus ? loaded : loaded.default;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const skip = (label, why) => console.log(`  SKIP  ${label}  ${why}`);

/** The colour the fake phone sends. Nothing on a desktop looks like this. */
const PHONE_RGB = { r: 255, g: 0, b: 255 };
const isPhoneColour = (b, g, r) => b > 180 && g < 80 && r > 180;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-recording-'));
const stateDir = path.join(workDir, 'state');
const outputPath = path.join(workDir, 'recording.mp4');
const sidecarPath = outputPath.replace(/\.mp4$/, '_camera.mp4');

service.configurePhoneCamera({ stateDir });

/** Average colour of a rectangle in a BGRA buffer, as [r, g, b]. */
function averageBgra(pixels, stride, x, y, w, h) {
  let b = 0;
  let g = 0;
  let r = 0;
  let n = 0;

  for (let row = Math.floor(y); row < Math.floor(y) + h; row += 1) {
    for (let col = Math.floor(x); col < Math.floor(x) + w; col += 1) {
      const i = row * stride * 4 + col * 4;
      b += pixels[i];
      g += pixels[i + 1];
      r += pixels[i + 2];
      n += 1;
    }
  }

  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
}

let stopper = null;
let posting = null;

try {
  console.log(`recording ${seconds}s with a simulated phone -> ${workDir}\n`);

  // ---- a phone that is sending --------------------------------------------

  console.log('pairing');
  const session = await service.startPhoneCamera();
  const token = new URL(session.url).searchParams.get('t');
  const frameUrl = `https://localhost:${session.port}/frame?t=${token}`;

  const jpeg = await sharp({
    create: { width: 1280, height: 720, channels: 3, background: PHONE_RGB },
  })
    .jpeg({ quality: 90 })
    .toBuffer();

  await fetch(frameUrl, { method: 'POST', body: jpeg });
  check('the simulated phone is sending', velocity.phoneCameraStatus().live === true);

  // Keep posting for the length of the take, at about the rate a phone would.
  // The recorder holds the last frame between arrivals, so the exact cadence
  // does not matter -- what is being checked is that anything arrives at all.
  let posted = 0;
  let stopPosting = false;
  posting = (async () => {
    while (!stopPosting) {
      await fetch(frameUrl, { method: 'POST', body: jpeg }).catch(() => {});
      posted += 1;
      await sleep(33);
    }
  })();

  // ---- record --------------------------------------------------------------

  console.log('\nrecording');
  try {
    stopper = velocity.startMonitorRecordingV2({
      outputPath,
      bitrate: 8_000_000,
      includeSystemAudio: false,
      targetFps: 30,
      enableWebcam: true,
      webcamSource: 'phone',
    });
    check('the recorder accepts a phone as its camera', true);
  } catch (error) {
    check('the recorder accepts a phone as its camera', false, error.message ?? String(error));
    throw error;
  }

  await sleep(seconds * 1000);

  const infos = stopper.stop();
  stopper = null;
  stopPosting = true;
  await posting;
  posting = null;

  console.log(`        posted ${posted} frames`);
  // Only the desktop capture registers stats -- the webcam sidecar never has,
  // for a local camera either -- so this is one entry, not two. The camera track
  // is checked on disk below, which is the thing that actually matters.
  check(
    'the recording reports its screen track',
    (infos?.length ?? 0) >= 1,
    `${infos?.length ?? 0}`,
  );

  // ---- what got written ----------------------------------------------------

  console.log('\nthe camera track');
  check('a camera sidecar was written', fs.existsSync(sidecarPath));

  if (!fs.existsSync(sidecarPath)) {
    skip('and it contains the phone picture', 'no sidecar to open');
  } else {
    const size = fs.statSync(sidecarPath).size;
    check('and it is not empty', size > 1024, `${(size / 1024).toFixed(0)} KB`);

    const player = velocity.VideoPlayer.open({ path: sidecarPath });
    try {
      const info = player.info();
      console.log(`        ${info.codedWidth}x${info.codedHeight}, ${info.duration.toFixed(0)}ms`);

      check(
        'it is the size the phone was sending',
        info.codedWidth === 1280 && info.codedHeight === 720,
        `${info.codedWidth}x${info.codedHeight}`,
      );

      // Roughly the length of the take. The sidecar loop advances its timestamps
      // on the clock whether or not a frame arrived, which is what keeps the two
      // tracks the same length -- so a short camera track means that broke.
      check(
        'it runs for about as long as the recording',
        info.duration > seconds * 1000 * 0.5,
        `${info.duration.toFixed(0)}ms of ${seconds * 1000}ms`,
      );

      player.seek(Math.min(500, info.duration / 2), true);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (player.tick()) break;
        await sleep(2);
      }
      await sleep(250);

      const pixels = player.snapshotBgra();
      check('it decodes', Boolean(pixels));

      if (pixels) {
        const [r, g, b] = averageBgra(pixels, info.codedWidth, 200, 200, 200, 200);
        check(
          'and the picture in it came from the phone',
          isPhoneColour(b, g, r),
          `rgb ${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)}`,
        );
      }
    } finally {
      player.close();
    }
  }

  // ---- refusing to start without one --------------------------------------

  console.log('\nwithout a phone');
  await service.stopPhoneCamera();
  velocity.resetPhoneCamera();

  const secondPath = path.join(workDir, 'second.mp4');
  let refused = false;
  let secondStopper = null;
  try {
    secondStopper = velocity.startMonitorRecordingV2({
      outputPath: secondPath,
      bitrate: 8_000_000,
      includeSystemAudio: false,
      targetFps: 30,
      enableWebcam: true,
      webcamSource: 'phone',
    });
  } catch {
    refused = true;
  } finally {
    secondStopper?.stop();
  }

  // Starting a take against a phone that is not there has to fail loudly. The
  // alternative is a recording whose camera track is a single frozen frame, or
  // absent entirely, discovered later in the editor.
  check('a recording will not start with no phone connected', refused);
} finally {
  try {
    stopper?.stop();
  } catch {
    /* already stopped */
  }
  await service.stopPhoneCamera().catch(() => {});
  await posting?.catch(() => {});
  fs.rmSync(workDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
