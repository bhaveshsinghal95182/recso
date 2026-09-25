// A separate process owns cleanup so Chromium has released its profile files.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tempRoot = path.resolve(os.tmpdir());
const testDir = fs.mkdtempSync(path.join(tempRoot, 'recso-webcam-preview-'));
const environment = { ...process.env, RECSO_WEBCAM_CHECK_DIR: testDir };
delete environment.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require('electron'), ['scripts/webcam-preview-app'], {
    windowsHide: true,
    stdio: 'inherit',
    env: environment,
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  assert.equal(path.dirname(path.resolve(testDir)), tempRoot);
  assert.ok(path.basename(testDir).startsWith('recso-webcam-preview-'));
  fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log('Removed temporary test recordings and database.');
}
