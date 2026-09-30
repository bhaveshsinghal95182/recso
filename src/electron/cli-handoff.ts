/**
 * `recso --cli <command>`: run recso-cli with this executable instead of the app.
 *
 * An AppImage can't put a second command on PATH, so its CLI is
 * `recso.AppImage --cli status`. main.ts imports this module before anything
 * else, so no window, tray or database is touched and the working directory
 * is still the caller's. The CLI runs in a child in Node mode
 * (ELECTRON_RUN_AS_NODE) with the terminal's stdio, and recso exits with its
 * code. The deb's /usr/bin/recso-cli and Windows' recso-cli.cmd run the same
 * script directly.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { app } from 'electron';

const flag = process.argv.indexOf('--cli');
if (flag >= 0) {
  const script = path.join(app.getAppPath(), 'dist-electron', 'automation', 'cli', 'recso-cli.js');
  const result = spawnSync(process.execPath, [script, ...process.argv.slice(flag + 1)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.error) process.stderr.write(`recso --cli: ${result.error.message}\n`);
  process.exit(result.status ?? 1);
}
