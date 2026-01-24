import { type BrowserWindow } from 'electron';

import { registerStatisticsHandlers, startStatisticsPolling } from './statistics.ipc.js';
import { registerWindowHandlers, setMainWindowRef } from './window.ipc.js';

export function registerAllIpcHandlers() {
  registerWindowHandlers();
  registerStatisticsHandlers();
}

export function initializeWithWindow(mainWindow: BrowserWindow) {
  setMainWindowRef(mainWindow);
  startStatisticsPolling(mainWindow);
}
