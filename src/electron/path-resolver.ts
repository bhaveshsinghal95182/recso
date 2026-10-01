import { app } from 'electron';

import path from 'path';

import { isDevelopment } from './util.js';

export function getPreloadPath() {
  // Keep the preload beside preload-engine.cjs, including inside app.asar.
  return path.join(app.getAppPath(), 'dist-electron/preload.cjs');
}

/** The app logo: `public/` in development, extraResources when packaged. */
export function getAppIconPath() {
  return isDevelopment()
    ? path.join(process.cwd(), 'public', 'R.png')
    : path.join(process.resourcesPath, 'public', 'R.png');
}
