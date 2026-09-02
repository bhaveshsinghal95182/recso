// Desktop + webcam + cursor, composited in the engine, verified by reading the
// finished frame back.
//
// Records both tracks, opens them as one player, places the camera box, loads a
// synthetic pointer path, and then checks the pixels actually changed where each
// layer was put -- and did not change where it was not. Colour readback is the
// only way to tell a composited frame from one that silently drew nothing.
//
// usage: node velocity/scripts/composition-check.mjs [seconds]

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const velocity = require(path.resolve(here, '..', 'index.js'));

const seconds = Number(process.argv[2] ?? 5);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-composition-'));
const screenPath = path.join(workDir, 'recording.mp4');
// The recorder derives the camera sidecar's name from the screen file.
const webcamPath = screenPath.replace(/\.mp4$/, '_camera.mp4');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function cleanup() {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Solid RGBA block, used as a stand-in cursor bitmap. */
function solidRgba(width, height, [r, g, b, a]) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = a;
  }
  return pixels;
}

/**
 * Average colour of a rectangle in a BGRA buffer.
 *
 * Coordinates are floored: a fractional index into a Buffer reads `undefined`
 * and quietly turns the whole average into NaN, which then compares false
 * against every threshold and looks like "nothing changed".
 */
function averageBgra(pixels, stride, x, y, w, h) {
  let b = 0;
  let g = 0;
  let r = 0;
  let n = 0;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);

  for (let row = y0; row < y0 + h; row += 1) {
    for (let col = x0; col < x0 + w; col += 1) {
      const i = row * stride * 4 + col * 4;
      b += pixels[i];
      g += pixels[i + 1];
      r += pixels[i + 2];
      n += 1;
    }
  }

  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
}

function difference(a, b) {
  const delta = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  if (!Number.isFinite(delta)) {
    throw new Error('sampled outside the frame; the comparison would be meaningless');
  }
  return delta;
}

try {
  // ---- record both tracks -------------------------------------------------

  console.log(`recording ${seconds}s of screen + webcam -> ${workDir}\n`);

  const devices = velocity.listWebcamDevices();
  if (devices.length === 0) {
    console.log('no webcam on this machine; cannot exercise the overlay');
    cleanup();
    process.exit(0);
  }
  console.log(`camera: ${devices.find((d) => d.isDefault)?.label ?? devices[0].label}\n`);

  const stopper = velocity.startMonitorRecordingV2({
    outputPath: screenPath,
    bitrate: 8_000_000,
    includeSystemAudio: false,
    targetFps: 30,
    enableWebcam: true,
  });

  await sleep(seconds * 1000);
  const infos = stopper.stop();

  console.log('recorder');
  const screen = infos.find((info) => info.role === 'screen');
  check('screen track written', Boolean(screen?.usable), `${screen?.frames ?? 0} frames`);
  check('camera sidecar exists', fs.existsSync(webcamPath));

  // ---- open both as one player -------------------------------------------

  console.log('\nplayer');
  const player = velocity.VideoPlayer.open({ path: screenPath, webcamPath });
  const info = player.info();

  check('webcam track opened', player.hasWebcam());
  console.log(`        canvas ${info.codedWidth}x${info.codedHeight}`);

  async function waitFrame(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = player.tick();
      if (frame) return frame;
      await sleep(2);
    }
    return null;
  }

  check('first frame decodes', (await waitFrame()) !== null);

  const stride = info.codedWidth;

  // Baseline: no overlays placed yet.
  const plain = player.snapshotBgra();
  check('snapshot reads back a frame', Boolean(plain), `${plain?.length ?? 0} bytes`);
  check(
    'snapshot is the full coded frame',
    plain?.length === info.codedWidth * info.codedHeight * 4,
  );

  // ---- webcam overlay -----------------------------------------------------

  const box = {
    x: Math.round(info.codedWidth * 0.6),
    y: Math.round(info.codedHeight * 0.6),
    width: Math.round(info.codedWidth * 0.25),
    height: Math.round(info.codedHeight * 0.25),
  };

  player.setWebcamLayout({ ...box, shape: 'rect', opacity: 1 });
  await sleep(400);
  const withWebcam = player.snapshotBgra();

  // Sample well inside the box, and somewhere the box does not reach.
  const inside = (buf) =>
    averageBgra(buf, stride, box.x + box.width / 4, box.y + box.height / 4, 40, 40);
  const outside = (buf) => averageBgra(buf, stride, 20, 20, 40, 40);

  check(
    'webcam changed pixels inside its box',
    difference(inside(plain), inside(withWebcam)) > 6,
    `delta ${difference(inside(plain), inside(withWebcam)).toFixed(1)}`,
  );
  check(
    'webcam left the rest of the frame alone',
    difference(outside(plain), outside(withWebcam)) < 6,
    `delta ${difference(outside(plain), outside(withWebcam)).toFixed(1)}`,
  );

  // An empty box is the off switch, and must cost nothing.
  player.setWebcamLayout({ x: 0, y: 0, width: 0, height: 0 });
  await sleep(400);
  const webcamOff = player.snapshotBgra();
  check(
    'a zero-size box removes the overlay',
    difference(inside(plain), inside(webcamOff)) < 6,
    `delta ${difference(inside(plain), inside(webcamOff)).toFixed(1)}`,
  );

  // ---- cursor -------------------------------------------------------------

  console.log('\ncursor');

  // A magenta block: nothing in a screen recording looks like this, so finding
  // it proves the sprite was drawn rather than something else moving.
  const CURSOR_PX = 64;
  player.setCursorImage({
    width: CURSOR_PX,
    height: CURSOR_PX,
    pixels: solidRgba(CURSOR_PX, CURSOR_PX, [255, 0, 255, 255]),
    hotspotX: 0,
    hotspotY: 0,
  });
  player.setCursorStyle(CURSOR_PX, 1);

  // Two samples far apart, so the pointer is in a different place depending on
  // where the playhead is.
  const duration = info.duration;
  player.setCursorTrack([
    { timestampMs: 0, x: 0.2, y: 0.2 },
    { timestampMs: duration * 0.5, x: 0.75, y: 0.75 },
  ]);
  await sleep(400);

  check('track loaded', player.cursorSampleCount() === 2, `${player.cursorSampleCount()} samples`);

  function findMagenta(buf) {
    if (!buf) return null;
    for (let row = 0; row < info.codedHeight; row += 4) {
      for (let col = 0; col < info.codedWidth; col += 4) {
        const i = row * stride * 4 + col * 4;
        // BGRA: blue and red high, green low.
        if (buf[i] > 200 && buf[i + 1] < 60 && buf[i + 2] > 200) {
          return { x: col, y: row };
        }
      }
    }
    return null;
  }

  player.seek(10, true);
  await waitFrame();
  await sleep(300);
  const early = findMagenta(player.snapshotBgra());

  check('cursor is drawn', early !== null, early ? `at ${early.x},${early.y}` : 'not found');
  if (early) {
    // First sample sits at 20% across, and the hotspot is the top-left corner.
    const wantX = 0.2 * info.codedWidth;
    const wantY = 0.2 * info.codedHeight;
    check(
      'cursor is at the position the track gives',
      Math.abs(early.x - wantX) < 40 && Math.abs(early.y - wantY) < 40,
      `found ${early.x},${early.y}, expected near ${wantX.toFixed(0)},${wantY.toFixed(0)}`,
    );
  }

  // Move the playhead past the second sample; the pointer should follow.
  player.seek(duration * 0.75, true);
  await waitFrame();
  await sleep(300);
  const late = findMagenta(player.snapshotBgra());

  check('cursor still drawn after a seek', late !== null, late ? `at ${late.x},${late.y}` : '');
  if (early && late) {
    check(
      'cursor moved to the later sample',
      late.x > early.x + 100 && late.y > early.y + 100,
      `${early.x},${early.y} -> ${late.x},${late.y}`,
    );
  }

  // Size 0 is the off switch.
  player.setCursorStyle(0, 1);
  await sleep(400);
  check('size 0 hides the cursor', findMagenta(player.snapshotBgra()) === null);

  player.close();
} finally {
  cleanup();
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
