import { type BrowserWindow } from 'electron';

import {
  registerRecorderHandlers,
  setRecorderMainWindow,
} from './recorder/standard-recorder.ipc.js';
import {
  registerVelocityRecorderHandlers,
  setVelocityRecorderMainWindow,
} from './recorder/velocity-recorder.ipc.js';
import { registerBackgroundHandlers } from './background.ipc.js';
import { registerCompositorHandlers } from './compositor.ipc.js';
import { registerDebugHandlers } from './debug.ipc.js';
import { registerEditorHandlers } from './editor.ipc.js';
import { registerExporterHandlers } from './exporter.ipc.js';
import { registerWindowEvents, registerWindowHandlers, setMainWindowRef } from './window.ipc.js';

export function registerAllIpcHandlers() {
  registerWindowHandlers();
  registerRecorderHandlers();
  registerVelocityRecorderHandlers();
  registerCompositorHandlers();
  registerDebugHandlers();
  registerEditorHandlers();
  registerBackgroundHandlers();
  registerExporterHandlers();
}

export function initializeWithWindow(mainWindow: BrowserWindow) {
  setMainWindowRef(mainWindow);
  setRecorderMainWindow(mainWindow);
  setVelocityRecorderMainWindow(mainWindow);
  registerWindowEvents(mainWindow);
}
