// The webcam box comes out the same size whichever side of the IPC resolves it.
//
// There are two implementations of this: `calculateWebcamLayout` in the main
// process, and `computeWebcamLayout` in the renderer. The preview and the export
// each reach for whichever is available, so a disagreement between them is not a
// rounding difference -- it is the preview showing one thing and the export
// producing another, with the size control promising whatever it feels like.
//
// That is exactly what happened: the main process capped the box at half the
// canvas width and the renderer did not, so a 16:9 overlay asked to be 75% tall
// came out 50% in the preview and 75% in the export.
//
// usage: node scripts/layout-check.mjs <dist-electron>

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (p) => import(pathToFileURL(path.resolve(p)).href);

const build = process.argv[2] ?? 'dist-electron';
const compositor = await load(path.join(build, 'services/compositor.service.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/**
 * The renderer's rule, transcribed from `functions/layout.ts`.
 *
 * Written out rather than imported because that module is renderer-only and
 * pulls in the editor's types. Transcribing it is the point of the exercise
 * anyway: if the two ever diverge again, this is where it shows.
 */
function rendererRule(canvasWidth, canvasHeight, { aspectRatio, heightRatio, marginPx }) {
  const margin = Math.min(
    Math.round(marginPx),
    Math.floor(Math.min(canvasWidth, canvasHeight) / 2),
  );
  let height = Math.max(1, Math.round(canvasHeight * heightRatio));
  let width = Math.max(1, Math.round(height * aspectRatio));

  const maxWidth = Math.max(1, canvasWidth - margin * 2);
  const maxHeight = Math.max(1, canvasHeight - margin * 2);

  if (width > maxWidth) {
    width = maxWidth;
    height = Math.max(1, Math.round(width / aspectRatio));
  }
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.max(1, Math.round(height * aspectRatio));
  }

  return { width, height };
}

const CANVASES = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 3840, height: 2160 },
];

// 3:4 portrait, 4:3, and 16:9 -- the three the shape picker offers.
const ASPECTS = [3 / 4, 4 / 3, 16 / 9];
const RATIOS = [0.08, 0.2, 0.34, 0.5, 0.75];

console.log('the two webcam layout rules agree');

let mismatches = 0;
for (const canvas of CANVASES) {
  for (const aspectRatio of ASPECTS) {
    for (const heightRatio of RATIOS) {
      const request = { anchor: 'bottom-right', aspectRatio, heightRatio, marginPx: 24 };
      const main = compositor.calculateWebcamLayout(canvas, request);
      const renderer = rendererRule(canvas.width, canvas.height, request);

      if (main.width !== renderer.width || main.height !== renderer.height) {
        mismatches += 1;
        console.log(
          `        ${canvas.width}x${canvas.height} ar=${aspectRatio.toFixed(2)} h=${heightRatio}` +
            ` main ${main.width}x${main.height} vs renderer ${renderer.width}x${renderer.height}`,
        );
      }
    }
  }
}

check(
  `across ${CANVASES.length * ASPECTS.length * RATIOS.length} combinations`,
  mismatches === 0,
  mismatches === 0 ? undefined : `${mismatches} disagree`,
);

console.log('\nthe size control means what it says');

// The case that prompted this: a landscape webcam at the slider's maximum.
for (const canvas of CANVASES) {
  const layout = compositor.calculateWebcamLayout(canvas, {
    anchor: 'center',
    aspectRatio: 16 / 9,
    heightRatio: 0.75,
    marginPx: 24,
  });
  const effective = layout.height / canvas.height;
  check(
    `a 16:9 overlay at 75% is 75% tall on ${canvas.width}x${canvas.height}`,
    Math.abs(effective - 0.75) < 0.01,
    `${(effective * 100).toFixed(0)}%`,
  );
}

// And the margins still bind, so nothing can grow past the frame.
const tight = compositor.calculateWebcamLayout(
  { width: 1920, height: 1080 },
  { anchor: 'center', aspectRatio: 16 / 9, heightRatio: 0.75, marginPx: 400 },
);
check(
  'a large margin still holds the box inside it',
  tight.width <= 1920 - 800 && tight.height <= 1080,
  `${tight.width}x${tight.height} with an 400px margin`,
);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
