import { app } from 'electron';

import path from 'path';

export function getPreloadPath() {
  // Keep the preload beside preload-engine.cjs, including inside app.asar.
  return path.join(app.getAppPath(), 'dist-electron/preload.cjs');
}
