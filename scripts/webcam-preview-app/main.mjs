// Hardware regression check. Opens the real recording screen in a hidden
// Electron window, enables the webcam, records briefly, then returns to preview.
// All capture files and the isolated test database are removed on completion.
// Run via scripts/webcam-preview-check.mjs, which owns the temporary directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow } from 'electron';
import { createServer } from 'vite';

const root = process.cwd();
const testDir = process.env.RECSO_WEBCAM_CHECK_DIR;
assert.ok(testDir, 'Run this app using scripts/webcam-preview-check.mjs');
for (const name of ['userData', 'temp', 'videos']) {
  const directory = path.join(testDir, name);
  fs.mkdirSync(directory);
  app.setPath(name, directory);
}
const require = createRequire(import.meta.url);
const velocity = require(path.join(root, 'velocity/index.js'));
const compiled = (name) => import(pathToFileURL(path.join(root, 'dist-electron', name)).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let window;
let server;
let recorder;
let database;
let exitCode = 1;
app.on('window-all-closed', () => {});

async function until(label, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

const js = (source) => window.webContents.executeJavaScript(source);
const clickLabel = (label) =>
  js(`(() => {
  const button = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)});
  if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(label)});
  button.click();
})()`);
const clickText = (text) =>
  js(`(() => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)});
  if (!button) throw new Error('Button unavailable: ' + ${JSON.stringify(text)});
  button.click();
})()`);

async function assertLivePreview(label) {
  await until(`${label}: pixels and no placeholder`, () =>
    js(`(() => {
    const canvas = document.querySelector('canvas');
    return canvas?.width > 0 && canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255
      && !canvas.parentElement.querySelector('[title]');
  })()`),
  );
  const before = await js('window.previewPaintCount');
  await sleep(2500);
  const state = await js(`(() => {
    const canvas = document.querySelector('canvas');
    const card = canvas.parentElement;
    return { paints: window.previewPaintCount, width: canvas.width, height: canvas.height,
      visibleWidth: canvas.getBoundingClientRect().width, padding: getComputedStyle(card).paddingTop };
  })()`);
  assert.ok(
    state.paints - before >= 10,
    `${label}: only ${state.paints - before} paints in 2.5 seconds`,
  );
  assert.ok(state.width <= 480 && state.height <= 360 && state.visibleWidth >= 90);
  assert.equal(state.padding, '0px');
  console.log(
    `PASS ${label}: ${state.paints - before} paints / 2.5s, ${state.width}x${state.height}`,
  );
}

// Keep an unforeseen driver stall from leaving the hidden test app running.
const watchdog = setTimeout(() => {
  console.error('FAIL native webcam preview check exceeded 90 seconds');
  app.exit(1);
}, 90000);

async function main() {
  try {
    await app.whenReady();
    database = await compiled('services/database.service.js');
    database.initializeDatabase();
    recorder = await compiled('services/recorder.service.js');
    const recorderIpc = await compiled('ipc/recorder.ipc.js');
    const phoneIpc = await compiled('ipc/phone-camera.ipc.js');
    recorderIpc.registerRecorderHandlers();
    phoneIpc.registerPhoneCameraHandlers();
    assert.ok(velocity.listWebcamDevices().length, 'A local webcam is required');

    server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
    await server.listen();
    const address = server.httpServer.address();
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        preload: path.join(root, 'dist-electron/preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    recorderIpc.setRecorderMainWindow(window);
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') console.error('[preview renderer]', event.message);
    });
    await window.loadURL(`http://127.0.0.1:${address.port}/scripts/webcam-preview-app/index.html`);
    await until('recording screen ready', () =>
      js(`!!document.querySelector('button[aria-label="Start recording"]')`),
    );
    await until('recording output is ready', () =>
      js(`!document.querySelector('button[aria-label="Start recording"]').disabled`),
    );
    await clickText('WebcamOff');
    await clickText('Disabled');
    await assertLivePreview('setup preview');
    await clickText('Enabled');
    await until('disabled camera releases preview', () => !recorder.nativeWebcamPreviewFrame());
    await clickText('Disabled');
    await assertLivePreview('preview after camera toggle');
    await clickLabel('Turn system audio off');
    await clickLabel('Start recording');
    await until('native recording starts', () => recorder.getState().state === 'RECORDING');
    await assertLivePreview('preview during native recording');
    // A delayed UI teardown must not close the recording's camera or its frame slot.
    recorder.stopNativeWebcamPreview();
    assert.ok(recorder.nativeWebcamPreviewFrame());
    const recordingId = recorder.getState().recordingId;
    await clickLabel('Stop recording');
    await until('native recording stops', () => recorder.getState().state === 'IDLE', 25000);
    await assertLivePreview('preview after recording');
    const recording = database.getRecording(recordingId);
    const cameraPath = recording.finalPath.replace(/\.mp4$/, '_camera.mp4');
    assert.ok(fs.statSync(cameraPath).size > 0, 'Native camera recording was written');
    const info = new velocity.VideoDecoder(cameraPath).info();
    assert.ok(
      info.duration > 1000 && info.width > 0 && info.height > 0,
      'Native camera recording decodes',
    );
    console.log('PASS recording still writes a decodable native webcam track');

    window.destroy();
    window = null;
    assert.equal(
      recorder.nativeWebcamPreviewFrame(),
      null,
      'Closing the window clears the preview',
    );
    const reopened = recorder.startNativeWebcamPreview();
    assert.ok(reopened.success, reopened.error);
    console.log('PASS camera released on window close and reopened with the default device');
    exitCode = 0;
  } catch (error) {
    console.error('FAIL native webcam preview check:', error.stack ?? error);
    if (window && !window.isDestroyed()) console.error(await js('document.body.innerText'));
  } finally {
    clearTimeout(watchdog);
    const activeId = recorder?.getState().recordingId;
    if (activeId) await recorder.stopRecording(activeId);
    window?.destroy();
    recorder?.stopNativeWebcamPreview();
    database?.closeDatabase();
    await server?.close();
    app.exit(exitCode);
  }
}

void main();
