import path from 'node:path';

import { app, ipcMain } from 'electron';

import {
  configurePhoneCamera,
  phoneCameraState,
  startPhoneCamera,
  stopPhoneCamera,
} from '../services/phone-camera.service.js';

/**
 * Everything about the app shell that the pairing service deliberately does not
 * know: where to keep its certificate, and where the native addon is.
 *
 * The same candidate walk the recorder and engine loaders do -- velocity lives
 * outside node_modules, so there is no resolvable specifier for it and the
 * packaged layout differs from the development one.
 */
function configure(): void {
  configurePhoneCamera({
    stateDir: app.getPath('userData'),
    velocityCandidates: [
      path.resolve(process.cwd(), 'velocity', 'index.js'),
      path.resolve(app.getAppPath(), 'velocity', 'index.js'),
      path.resolve(app.getAppPath(), '..', 'velocity', 'index.js'),
      path.resolve(process.resourcesPath, 'velocity', 'index.js'),
      path.resolve(process.resourcesPath, 'app.asar.unpacked', 'velocity', 'index.js'),
    ],
  });
}

export function registerPhoneCameraHandlers() {
  configure();

  ipcMain.handle('phone-camera:start', () => startPhoneCamera());
  ipcMain.handle('phone-camera:stop', () => stopPhoneCamera());
  ipcMain.handle('phone-camera:state', () => phoneCameraState());

  // A pairing server outliving the window it was opened from would keep a port
  // open with nothing watching it.
  app.on('will-quit', () => {
    void stopPhoneCamera();
  });
}
