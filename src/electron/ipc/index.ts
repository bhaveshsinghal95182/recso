import { type BrowserWindow } from 'electron';

import { registerCompositorHandlers } from './compositor.ipc.js';
import { registerDebugHandlers } from './debug.ipc.js';
import { registerEditorHandlers } from './editor.ipc.js';
import { registerExporterHandlers } from './exporter.ipc.js';
import { registerRecorderHandlers, setRecorderMainWindow } from './recorder.ipc.js';
import { registerWindowEvents, registerWindowHandlers, setMainWindowRef } from './window.ipc.js';

export function registerAllIpcHandlers() {
  registerWindowHandlers();
  registerRecorderHandlers();
  registerCompositorHandlers();
  registerDebugHandlers();
  registerEditorHandlers();
  registerExporterHandlers();
}

export function initializeWithWindow(mainWindow: BrowserWindow) {
  setMainWindowRef(mainWindow);
  setRecorderMainWindow(mainWindow);
  registerWindowEvents(mainWindow);
}
