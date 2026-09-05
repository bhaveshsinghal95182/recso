// Export options survive the trip from the renderer to napi.
//
// This is the seam that has now produced two bugs, both the same shape: code
// that only runs between the renderer and the native addon, in a module that
// imports electron and therefore cannot be loaded by any test.
//
// The first was the recorder deciding whether to use the native path at all.
// The second was this one -- pixel buffers arrive as `ArrayBuffer` because
// structured clone unwraps them, napi will not take one, and the main-process
// types say `Buffer` because that is what napi needs rather than what shows up.
// TypeScript cannot warn about a type that describes the destination.
//
// usage: node scripts/export-options-check.mjs <dist-electron>

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (p) => import(pathToFileURL(path.resolve(p)).href);

const build = process.argv[2] ?? 'dist-electron';
const { normaliseExportOptions } = await load(
  path.join(build, 'services/engine/export-options.js'),
);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** A bitmap as it arrives from the renderer: pixels unwrapped to ArrayBuffer. */
const wireBitmap = (fill) => ({
  width: 2,
  height: 1,
  pixels: Uint8Array.from([fill, fill, fill, 255, fill, fill, fill, 255]).buffer,
  hotspotX: 1,
  hotspotY: 0,
});

console.log('pixel buffers napi can actually read');

const { options } = normaliseExportOptions('C:\\clips\\take.mp4', {
  output: 'C:\\clips\\out.mp4',
  bitrate: 12_000_000,
  cursor: wireBitmap(1),
  cursorImages: [wireBitmap(2), wireBitmap(3)],
  background: { colour: { r: 0, g: 0, b: 0, a: 1 }, image: wireBitmap(4) },
});

check('the cursor bitmap is a Buffer', Buffer.isBuffer(options.cursor.pixels));
check(
  'every bitmap in the cursor table is too',
  options.cursorImages.length === 2 && options.cursorImages.every((i) => Buffer.isBuffer(i.pixels)),
);
check('and the background image', Buffer.isBuffer(options.background.image.pixels));

// The bug was found on `cursor` alone. The other two arrive the same way and
// would have failed the same way, one export at a time.
check(
  'the pixels themselves are unchanged',
  options.cursor.pixels[0] === 1 &&
    options.cursorImages[1].pixels[0] === 3 &&
    options.background.image.pixels[0] === 4,
);
check(
  'and the rest of the bitmap survives',
  options.cursor.width === 2 && options.cursor.height === 1 && options.cursor.hotspotX === 1,
);

console.log('\nnothing required is invented');

const bare = normaliseExportOptions('in.mp4', { output: 'out.mp4', bitrate: 8_000_000 });
check('no cursor stays no cursor', bare.options.cursor === undefined);
check('no cursor table stays undefined', bare.options.cursorImages === undefined);
check('no background stays undefined', bare.options.background === undefined);
check('no webcam sidecar stays undefined', bare.options.webcamPath === undefined);

console.log('\npaths Media Foundation will accept');

const quoted = normaliseExportOptions('"C:\\clips\\take.mp4"', {
  output: '"C:\\clips\\out.mp4"',
  bitrate: 8_000_000,
  webcamPath: '"C:\\clips\\take_camera.mp4"',
  audioSources: [{ path: '"C:\\clips\\take_mic.mp4"', offsetMs: 40 }],
});

check('the input is de-quoted', !quoted.input.includes('"'), quoted.input);
check('so is the output', !quoted.options.output.includes('"'), quoted.options.output);
check('so is the camera sidecar', !quoted.options.webcamPath.includes('"'));
check(
  'and every audio source, which is silent when it is wrong',
  quoted.options.audioSources.every((s) => !s.path.includes('"')),
);
check('while their offsets are left alone', quoted.options.audioSources[0].offsetMs === 40);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
