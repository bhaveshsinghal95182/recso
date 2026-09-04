import { type BrowserWindow } from 'electron';

import { registerBackgroundHandlers } from './background.ipc.js';
import { registerCompositorHandlers } from './compositor.ipc.js';
import { registerDebugHandlers } from './debug.ipc.js';
import { registerEditorHandlers } from './editor.ipc.js';
import { registerEngineHandlers } from './engine.ipc.js';
import { registerExporterHandlers } from './exporter.ipc.js';
import { registerLoggingHandlers } from './logging.ipc.js';
import { registerPhoneCameraHandlers } from './phone-camera.ipc.js';
import { registerRecentProjectsHandlers } from './recent-projects.ipc.js';
import { registerRecorderHandlers, setRecorderMainWindow } from './recorder.ipc.js';
import { registerTelemetryHandlers } from './telemetry.ipc.js';
import { registerWindowEvents, registerWindowHandlers, setMainWindowRef } from './window.ipc.js';

export function registerAllIpcHandlers() {
  registerWindowHandlers();
  registerRecorderHandlers();
  registerCompositorHandlers();
  registerDebugHandlers();
  registerEditorHandlers();
  registerEngineHandlers();
  registerBackgroundHandlers();
  registerExporterHandlers();
  registerTelemetryHandlers();
  registerRecentProjectsHandlers();
  registerLoggingHandlers();
  registerPhoneCameraHandlers();
}

export function initializeWithWindow(mainWindow: BrowserWindow) {
  setMainWindowRef(mainWindow);
  setRecorderMainWindow(mainWindow);
  registerWindowEvents(mainWindow);
}
