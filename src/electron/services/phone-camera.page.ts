/**
 * The page the phone runs.
 *
 * Served inline rather than as a file on disk because it has to carry the
 * session token, and because a phone camera page with no build step, no bundle
 * and no imports is one fewer thing that can be out of date relative to the
 * server that serves it.
 *
 * Two decisions here matter more than the rest:
 *
 * **The canvas size is locked to the camera, once.** The sidecar encoder fixes
 * its dimensions on the first frame and an MP4 track cannot change size partway
 * through, so the page must never change what it sends mid-session -- rotating
 * the phone would otherwise make the recorder reject every frame after the turn
 * and freeze the take on the last upright picture.
 *
 * But the size has to come from the camera rather than be assumed. A hardcoded
 * 16:9 canvas with a cover fit throws away most of a portrait stream: a
 * 1080x1920 phone covered into 1280x720 keeps about a third of its height and
 * looks like someone zoomed in and never said so. So the first frame's real
 * dimensions decide the canvas, scaled down to a sensible long side, and every
 * frame after that goes into the same one.
 *
 * **One frame in flight at a time.** The next frame is only captured once the
 * previous POST has come back. That is the whole of the flow control: on a good
 * link it runs at the requested rate, and on a bad one it slows down to whatever
 * the link can carry instead of queueing frames the recorder would throw away.
 * The recorder keeps a single slot for exactly the same reason -- a late frame
 * does not get its own moment in the timeline, it gets somebody else's.
 */

/**
 * Longest side of a captured frame.
 *
 * A cap rather than a size, so the aspect ratio is the camera's. 1280 is about
 * 2-3 MB/s as JPEG at 30fps, which a home network carries; the phone's sensor
 * can do far more and the link cannot.
 */
const MAX_LONG_SIDE = 1280;

/** Until the camera opens and says what it actually produces. */
const FALLBACK_WIDTH = 1280;
const FALLBACK_HEIGHT = 720;
const TARGET_FPS = 30;
const JPEG_QUALITY = 0.72;

/**
 * The capture size for a camera of this shape.
 *
 * Exported, and stringified into the page below rather than written out twice,
 * because this is the rule that decides whether the recording looks like what
 * the phone is pointing at. Getting it wrong does not fail -- it silently crops,
 * which is how a portrait stream ended up looking zoomed in.
 *
 * Even numbers because H.264 subsamples chroma 2x2 and an odd dimension is
 * either rejected or quietly rounded by the encoder.
 */
export function captureSizeFor(
  sourceWidth: number,
  sourceHeight: number,
  maxLongSide: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxLongSide / Math.max(sourceWidth, sourceHeight));
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(sourceWidth), height: even(sourceHeight) };
}

export function capturePageHtml(token: string): string {
  // The token is hex from `randomBytes`, so there is nothing in it that needs
  // escaping -- but it is interpolated into a script, so assert rather than
  // assume. A malformed token here would be a script injection into a page we
  // are handing to a device we do not control.
  if (!/^[0-9a-f]{8,64}$/.test(token)) {
    throw new Error('refusing to build the capture page with a malformed token');
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Recso camera</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh;
    background: #0b0b0d; color: #f4f4f5;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; flex-direction: column;
  }
  header { padding: 14px 18px calc(14px + env(safe-area-inset-top)); }
  h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  #stage { flex: 1; display: grid; place-items: center; padding: 0 12px; min-height: 0; }
  video {
    width: 100%; max-height: 100%; border-radius: 14px;
    background: #17171b; transform: scaleX(var(--mirror, 1));
  }
  footer {
    padding: 14px 18px calc(18px + env(safe-area-inset-bottom));
    display: flex; flex-direction: column; gap: 12px;
  }
  .row { display: flex; gap: 10px; }
  button {
    flex: 1; padding: 13px 16px; border: 0; border-radius: 11px;
    background: #26262c; color: #f4f4f5; font: inherit; font-weight: 500;
    -webkit-tap-highlight-color: transparent;
  }
  button:active { background: #313139; }
  button.primary { background: #f4f4f5; color: #0b0b0d; }
  button:disabled { opacity: 0.4; }
  #status { display: flex; align-items: center; gap: 9px; font-size: 13px; color: #a1a1aa; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #52525b; flex: none; }
  #dot.live { background: #22c55e; }
  #dot.bad { background: #ef4444; }
  #hint {
    font-size: 13px; color: #a1a1aa; margin: 0;
    padding: 11px 13px; background: #17171b; border-radius: 11px;
  }
  canvas { display: none; }
</style>
</head>
<body>
<header><h1>Recso camera</h1></header>

<div id="stage"><video id="preview" playsinline autoplay muted></video></div>

<footer>
  <div id="status"><span id="dot"></span><span id="statusText">Not started</span></div>
  <p id="hint">Hold your phone in landscape. Keep this screen on and this tab in front &mdash; phones stop the camera when the browser goes to the background.</p>
  <div class="row">
    <button id="start" class="primary">Start camera</button>
    <button id="flip" disabled>Flip</button>
  </div>
</footer>

<canvas id="scratch" width="${FALLBACK_WIDTH}" height="${FALLBACK_HEIGHT}"></canvas>

<script>
(() => {
  const TOKEN = ${JSON.stringify(token)};
  const MAX_LONG_SIDE = ${MAX_LONG_SIDE};
  // One definition, shared with the desktop so the rule can actually be tested.
  const captureSizeFor = ${captureSizeFor.toString()};
  const FRAME_MS = ${Math.round(1000 / TARGET_FPS)};
  const QUALITY = ${JPEG_QUALITY};

  const preview = document.getElementById('preview');
  const canvas = document.getElementById('scratch');
  const context = canvas.getContext('2d', { alpha: false });
  const startButton = document.getElementById('start');
  const flipButton = document.getElementById('flip');
  const dot = document.getElementById('dot');
  const statusText = document.getElementById('statusText');
  const hint = document.getElementById('hint');

  let stream = null;
  let facing = 'environment';
  let running = false;
  let sending = false;
  let sent = 0;
  let failures = 0;
  // Fixed for the whole session once the camera has said what it produces.
  let captureWidth = 0;
  let captureHeight = 0;

  const url = (route) => route + '?t=' + encodeURIComponent(TOKEN);

  function setStatus(text, kind) {
    statusText.textContent = text;
    dot.className = kind || '';
  }

  async function report(message) {
    try {
      await fetch(url('/problem'), { method: 'POST', body: String(message) });
    } catch { /* the desktop is the thing that went away; nothing to do */ }
  }

  async function open() {
    stop();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facing,
          // Hints only. What actually arrives decides the canvas, because a
          // phone answers these in whatever orientation it feels like and
          // assuming otherwise is what crops a portrait stream to a third of
          // itself.
          width: { ideal: MAX_LONG_SIDE },
          height: { ideal: Math.round(MAX_LONG_SIDE * 9 / 16) },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    } catch (error) {
      const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      const message = denied
        ? 'Camera permission was refused on the phone'
        : 'The phone could not open its camera: ' + (error && error.message ? error.message : error);
      setStatus(denied ? 'Permission refused' : 'No camera', 'bad');
      hint.textContent = denied
        ? 'Allow camera access for this page, then tap Start camera again.'
        : message;
      report(message);
      return false;
    }

    preview.srcObject = stream;
    // The front camera is mirrored for the person holding it, the same way a
    // laptop webcam preview is. Only the preview -- what gets sent is not
    // flipped, because the recording should match the room, not the mirror.
    preview.style.setProperty('--mirror', facing === 'user' ? '-1' : '1');
    await preview.play().catch(() => {});
    await lockCaptureSize();
    flipButton.disabled = false;
    return true;
  }

  /**
   * Fix the capture size to this camera's shape, the first time only.
   *
   * Once, because the recorder's encoder fixes its dimensions on the first
   * frame and an MP4 track cannot change size partway through -- so a flip to a
   * camera with a different aspect keeps the locked size and is covered into
   * it, which crops, rather than resizing and breaking the take.
   */
  async function lockCaptureSize() {
    if (captureWidth) return;

    // videoWidth is 0 until metadata lands, which is usually but not always
    // before play() resolves.
    if (!preview.videoWidth) {
      await new Promise((resolve) => {
        const done = () => resolve();
        preview.addEventListener('loadedmetadata', done, { once: true });
        setTimeout(done, 2000);
      });
    }

    const size = captureSizeFor(
      preview.videoWidth || ${FALLBACK_WIDTH},
      preview.videoHeight || ${FALLBACK_HEIGHT},
      MAX_LONG_SIDE,
    );
    captureWidth = size.width;
    captureHeight = size.height;
    canvas.width = captureWidth;
    canvas.height = captureHeight;
  }

  function stop() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
  }

  /**
   * Draw the camera into the locked canvas, covering it.
   *
   * Normally a no-op scale: the canvas was sized from this camera, so the
   * aspect ratios match and nothing is cropped. It only crops after a flip to a
   * camera shaped differently from the one the session started with, which is
   * the right trade against resizing a track mid-recording.
   */
  function drawCovered() {
    const sourceWidth = preview.videoWidth;
    const sourceHeight = preview.videoHeight;
    if (!sourceWidth || !sourceHeight || !captureWidth) return false;

    const scale = Math.max(captureWidth / sourceWidth, captureHeight / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;

    context.drawImage(
      preview,
      (captureWidth - drawWidth) / 2,
      (captureHeight - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
    return true;
  }

  const encode = () =>
    new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));

  async function pump() {
    while (running) {
      const started = performance.now();

      if (!sending && drawCovered()) {
        sending = true;
        try {
          const blob = await encode();
          if (blob) {
            const response = await fetch(url('/frame'), { method: 'POST', body: blob });
            if (!response.ok) throw new Error('the desktop refused the frame');
            sent += 1;
            failures = 0;
            if (sent % 15 === 0) setStatus('Sending \\u2014 ' + sent + ' frames', 'live');
          }
        } catch {
          failures += 1;
          // A handful of misses is wifi. A steady run of them means the desktop
          // has gone: stopped recording, closed the panel, or left the network.
          if (failures > 30) {
            setStatus('Lost the desktop', 'bad');
            hint.textContent = 'The connection dropped. Make sure both devices are on the same network, then scan the code again.';
            running = false;
          } else {
            setStatus('Reconnecting\\u2026', 'bad');
          }
        } finally {
          sending = false;
        }
      }

      // Pace against when this frame started, so encoding time comes out of the
      // interval rather than being added to it.
      const spent = performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, FRAME_MS - spent)));
    }
  }

  startButton.addEventListener('click', async () => {
    if (running) {
      running = false;
      stop();
      startButton.textContent = 'Start camera';
      startButton.classList.add('primary');
      setStatus('Stopped');
      return;
    }

    startButton.disabled = true;
    const opened = await open();
    startButton.disabled = false;
    if (!opened) return;

    running = true;
    sent = 0;
    failures = 0;
    startButton.textContent = 'Stop';
    startButton.classList.remove('primary');
    setStatus('Sending', 'live');
    hint.textContent = 'Your camera is showing on the desktop. Leave this screen on while you record.';
    pump();
  });

  flipButton.addEventListener('click', async () => {
    facing = facing === 'user' ? 'environment' : 'user';
    await open();
  });

  // A phone suspends the camera when the browser is backgrounded, and the
  // desktop would just see the picture freeze. Say so on both ends.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running) {
      setStatus('Paused \\u2014 come back to this tab', 'bad');
      report('The phone backgrounded the browser, so the camera paused');
    } else if (running) {
      setStatus('Sending', 'live');
    }
  });

  const events = new EventSource(url('/events'));
  events.addEventListener('ended', () => {
    running = false;
    stop();
    setStatus('The desktop closed this session');
    hint.textContent = 'Open the phone camera panel on the desktop again to reconnect.';
    startButton.disabled = true;
    flipButton.disabled = true;
  });

  window.addEventListener('pagehide', () => {
    running = false;
    stop();
  });
})();
</script>
</body>
</html>`;
}
