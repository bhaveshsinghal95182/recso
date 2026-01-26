import { type BrowserWindow } from 'electron';

import { registerRecorderHandlers, setRecorderMainWindow } from './recorder.ipc.js';
import { registerStatisticsHandlers, startStatisticsPolling } from './statistics.ipc.js';
import { registerWindowEvents, registerWindowHandlers, setMainWindowRef } from './window.ipc.js';

export function registerAllIpcHandlers() {
  registerWindowHandlers();
  registerStatisticsHandlers();
  registerRecorderHandlers();
}

export function initializeWithWindow(mainWindow: BrowserWindow) {
  setMainWindowRef(mainWindow);
  setRecorderMainWindow(mainWindow);
  startStatisticsPolling(mainWindow);
  registerWindowEvents(mainWindow);
}
