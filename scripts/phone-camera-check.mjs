// Exercises the phone pairing server headlessly: the token gate, the page, the
// frame route, the SSE control channel, and shutdown.
//
// Run against the compiled output, so this checks what actually ships rather
// than a re-implementation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

// The certificate is self-signed by design, so verification has to be off for
// the HTTP calls below. The SAN list is checked explicitly instead -- see the
// "certificate" section, which is the part that actually matters.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const load = (p) => import(pathToFileURL(path.resolve(p)).href);

const build = process.argv[2];
const service = await load(path.join(build, 'services/phone-camera.service.js'));
const sharp = (await load('node_modules/sharp/lib/index.js')).default;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const get = (url, init) => fetch(url, init);

/** The certificate the server actually presents, as the phone would see it. */
function presentedCertificate(port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { port, host: 'localhost', servername: 'localhost', rejectUnauthorized: false },
      () => {
        const certificate = socket.getPeerCertificate();
        socket.end();
        resolve(certificate);
      },
    );
    socket.on('error', reject);
  });
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-camera-'));
service.configurePhoneCamera({ stateDir });

try {
  console.log('addresses');
  const addresses = service.localAddresses();
  console.log(`        ${addresses.join(', ') || '(none)'}`);
  check('this machine has a reachable address', addresses.length > 0);

  console.log('\nserver');
  const session = await service.startPhoneCamera();
  console.log(`        ${session.url.replace(/t=.*/, 't=...')}`);
  check('the server starts', Boolean(session.url));
  check('and offers every interface', session.urls.length === addresses.length);

  const base = new URL(session.url);
  const token = base.searchParams.get('t');
  const at = (route, query = '') => `https://localhost:${session.port}${route}?t=${token}${query}`;

  check('the token is long enough to not be guessed', token.length >= 32, `${token.length} chars`);

  // ---- which capture path a phone implies ---------------------------------
  //
  // This is the layer the end-to-end recording check flies straight past: it
  // calls the native recorder directly, so it never exercises the decision
  // about *whether* to call it. That decision is where a phone silently
  // recorded nothing -- the native path was off by default, so the camera block
  // was skipped entirely, and the renderer sidecar is deliberately disabled for
  // a phone because it can only open a local camera. No track, no error.

  console.log('\nthe capture plan');
  const plan = await load(path.join(build, 'services/recorder-capture-plan.js'));

  check('native is the default', plan.shouldUseNativeSingularClock({}) === true);
  check(
    'a phone turns it on by itself',
    plan.shouldUseNativeSingularClock({ cameraSource: 'phone' }) === true,
  );
  check(
    'an explicit legacy mode opts out',
    plan.shouldUseNativeSingularClock({ nativeCaptureMode: 'legacy' }) === false,
  );
  check(
    'and so does the environment escape hatch',
    plan.shouldUseNativeSingularClock({ legacyForced: true }) === false,
  );
  check(
    'but neither can strand a phone with no camera track',
    plan.shouldUseNativeSingularClock({ cameraSource: 'phone', legacyForced: true }) === true &&
      plan.shouldUseNativeSingularClock({
        cameraSource: 'phone',
        nativeCaptureMode: 'legacy',
      }) === true,
  );

  // Audio captured natively goes into the video's own track, which is what
  // removes the offset nobody could measure: sidecars start whenever a device
  // finishes opening, and the mux could only guess how late that was.
  const audio = (input) => plan.planNativeAudio({ platform: 'win32', ...input });

  check(
    'system audio is captured natively on the native path',
    audio({ useSingularClock: true, recordSystemAudio: true }).systemAudio === true,
  );
  check(
    'so is the microphone',
    audio({ useSingularClock: true, recordMic: true }).microphone === true,
  );
  check(
    'neither is captured when it was not asked for',
    audio({ useSingularClock: true }).systemAudio === false &&
      audio({ useSingularClock: true }).microphone === false,
  );
  check(
    'the legacy path keeps its renderer sidecars',
    audio({ useSingularClock: false, recordSystemAudio: true, recordMic: true }).systemAudio ===
      false,
  );
  check(
    'and so does everything that is not Windows, since this is WASAPI',
    plan.planNativeAudio({
      platform: 'darwin',
      useSingularClock: true,
      recordSystemAudio: true,
      recordMic: true,
    }).microphone === false,
  );

  check(
    'a phone that is not sending stops the recording starting',
    plan.phoneCameraProblem({ recordCamera: true, cameraSource: 'phone' }, false) !== null,
  );
  check(
    'a phone that is sending does not',
    plan.phoneCameraProblem({ recordCamera: true, cameraSource: 'phone' }, true) === null,
  );
  check(
    'and a local camera is never blocked by the phone check',
    plan.phoneCameraProblem({ recordCamera: true, cameraSource: 'local' }, false) === null,
  );
  check(
    'nor is a recording with no camera at all',
    plan.phoneCameraProblem({ recordCamera: false, cameraSource: 'phone' }, false) === null,
  );

  console.log('\ncertificate');
  const certificate = await presentedCertificate(session.port);
  const sans = String(certificate.subjectaltname || '');
  console.log(`        ${sans}`);
  check(
    'it covers localhost, so the desktop can open the page too',
    sans.includes('DNS:localhost'),
  );
  check(
    'and every address the phone might arrive on',
    addresses.every((address) => sans.includes(`IP Address:${address}`)),
  );
  // iOS refuses a server certificate valid for more than 398 days outright, so
  // an over-long one would fail on exactly the device this feature is for.
  const lifetimeDays =
    (Date.parse(certificate.valid_to) - Date.parse(certificate.valid_from)) / 86400000;
  check(
    'and lasts under the 398 days iOS will accept',
    lifetimeDays > 0 && lifetimeDays < 398,
    `${lifetimeDays.toFixed(0)} days`,
  );

  console.log('\nthe token gate');
  const noToken = await get(`https://localhost:${session.port}/`);
  check('a request with no token is refused', noToken.status === 404, `${noToken.status}`);

  const wrongToken = await get(`https://localhost:${session.port}/?t=${'0'.repeat(token.length)}`);
  check('and so is one with the wrong token', wrongToken.status === 404, `${wrongToken.status}`);

  const wrongLength = await get(`https://localhost:${session.port}/?t=abc`);
  check('a short token does not crash the compare', wrongLength.status === 404);

  console.log('\nthe page');
  const page = await load(path.join(build, 'services/phone-camera.page.js'));
  const served = await get(at('/'));
  const html = await served.text();
  check('the page is served', served.status === 200);
  check('it carries the session token', html.includes(token));
  check('it is not cached', served.headers.get('cache-control') === 'no-store');
  check('it asks for the camera', html.includes('getUserMedia'));
  check(
    'it locks the capture size once, so rotating the phone cannot resize the track',
    html.includes('captureSizeFor') && html.includes('if (captureWidth) return'),
  );

  // ---- the capture size ----------------------------------------------------
  //
  // The rule that decides whether the recording looks like what the phone is
  // pointing at. Getting it wrong does not fail, it silently crops -- a
  // hardcoded 16:9 canvas kept about a third of a portrait stream and looked
  // like someone had zoomed in.

  const size = (w, h) => page.captureSizeFor(w, h, 1280);

  check(
    'a portrait stream stays portrait',
    size(1080, 1920).width === 720 && size(1080, 1920).height === 1280,
    JSON.stringify(size(1080, 1920)),
  );
  check(
    'a landscape stream is capped, not reshaped',
    size(1920, 1080).width === 1280 && size(1920, 1080).height === 720,
    JSON.stringify(size(1920, 1080)),
  );
  check(
    'a 4:3 camera keeps its shape',
    size(640, 480).width === 640 && size(640, 480).height === 480,
    JSON.stringify(size(640, 480)),
  );
  check(
    'nothing is scaled up past what the camera gave',
    size(320, 240).width === 320 && size(320, 240).height === 240,
    JSON.stringify(size(320, 240)),
  );
  check(
    'dimensions come out even, because H.264 subsamples chroma 2x2',
    [size(1281, 721), size(641, 481), size(999, 333)].every(
      (dimensions) => dimensions.width % 2 === 0 && dimensions.height % 2 === 0,
    ),
  );

  console.log('\nframes');
  service.startPhoneCamera(); // idempotent; must not restart underneath us
  const loaded = await load('velocity/index.js');
  const velocity = loaded.phoneCameraStatus ? loaded : loaded.default;

  check('no frames before the phone sends any', velocity.phoneCameraStatus().live === false);

  const jpeg = await sharp({
    create: { width: 1280, height: 720, channels: 3, background: { r: 12, g: 200, b: 90 } },
  })
    .jpeg()
    .toBuffer();

  const posted = await get(at('/frame'), { method: 'POST', body: jpeg });
  check('a frame is accepted', posted.status === 204, `${posted.status}`);

  // The desktop preview reads this, not the recorder's slot: the recorder
  // empties its slot as soon as it writes a frame, so by the time a preview
  // asked there would be nothing to show.
  const held = service.latestPhoneFrame();
  check(
    'the newest frame is held for the desktop preview',
    Boolean(held) && held.length === jpeg.length,
    `${held ? held.length : 0} bytes`,
  );

  const status = velocity.phoneCameraStatus();
  check('and reaches the recorder', status.live === true);
  check(
    'at the size it was sent',
    status.width === 1280 && status.height === 720,
    `${status.width}x${status.height}`,
  );

  const unauthorisedFrame = await fetch(`https://localhost:${session.port}/frame`, {
    method: 'POST',
    body: jpeg,
  });
  check('a frame with no token is refused', unauthorisedFrame.status === 404);

  const garbage = await get(at('/frame'), { method: 'POST', body: Buffer.from('nope') });
  check('a frame that is not a JPEG is refused', garbage.status === 400, `${garbage.status}`);

  console.log('\nthe control channel');
  const events = await get(at('/events'));
  check('the event stream opens', events.headers.get('content-type') === 'text/event-stream');

  const reader = events.body.getReader();
  const first = await reader.read();
  check('and says how to retry', new TextDecoder().decode(first.value).includes('retry:'));

  const ended = new Promise((resolve) => {
    (async () => {
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes('event: ended')) {
          resolve(true);
          return;
        }
      }
      resolve(false);
    })();
  });

  console.log('\nshutdown');
  await service.stopPhoneCamera();
  check('the phone is told the session ended', await ended);
  check('the recorder forgets the last frame', velocity.phoneCameraStatus().live === false);

  let refused = false;
  try {
    await get(at('/'));
  } catch {
    refused = true;
  }
  check('and the port stops answering', refused);
} finally {
  await service.stopPhoneCamera().catch(() => {});
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
// Let the process drain rather than exiting on the spot: an SSE reader is
// still holding a socket whose server just closed, and tearing that down from
// under undici trips a libuv assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1;
