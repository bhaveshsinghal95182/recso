import { type BrowserWindow } from 'electron';

import { registerCompositorHandlers } from './compositor.ipc.js';
import { registerDebugHandlers } from './debug.ipc.js';
import { registerEditorHandlers } from './editor.ipc.js';
import { registerRecorderHandlers, setRecorderMainWindow } from './recorder.ipc.js';
import { registerStatisticsHandlers, startStatisticsPolling } from './statistics.ipc.js';
import { registerWindowEvents, registerWindowHandlers, setMainWindowRef } from './window.ipc.js';

export function registerAllIpcHandlers() {
  registerWindowHandlers();
  registerStatisticsHandlers();
  registerRecorderHandlers();
  registerCompositorHandlers();
  registerDebugHandlers();
  registerEditorHandlers();
}

export function initializeWithWindow(mainWindow: BrowserWindow) {
  setMainWindowRef(mainWindow);
  setRecorderMainWindow(mainWindow);
  startStatisticsPolling(mainWindow);
  registerWindowEvents(mainWindow);
}
