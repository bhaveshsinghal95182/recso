import { app, BrowserWindow, screen } from 'electron';

// APPX/MSIX Store apps launch with cwd = C:\WINDOWS\system32 (read-only).
// Redirect to writable userData folder before anything else runs.
if (app.isPackaged) {
  process.chdir(app.getPath('userData'));
}

import path from 'path';

import { initializeWithWindow, registerAllIpcHandlers } from './ipc/index.js';
import { initializeDatabase } from './services/database.service.js';
import { checkGpuMatch } from './services/engine/gpu.service.js';
import { initializeTelemetry } from './services/telemetry/telemetry.service.js';
import { createTray } from './services/tray.service.js';
import { initializeLogging } from './utils/logger.js';
import { getPreloadPath } from './path-resolver.js';
import { isDevelopment } from './util.js';

// Shared textures cannot cross adapters. The engine builds its D3D11 device on
// the high-performance GPU, so Chromium's GPU process has to be there too, or
// every importSharedTexture is handed a handle from a device it cannot open.
//
// Must be set before the app is ready; afterwards the GPU process is already
// up. Harmless when the engine is absent -- Chromium just prefers the discrete
// GPU, which is what a recorder and video editor want anyway.
if (process.env.RECSO_ENGINE_GPU !== 'integrated') {
  app.commandLine.appendSwitch('force_high_performance_gpu');
}

app.on('ready', () => {
  initializeLogging({ mirrorConsole: isDevelopment() });

  // Initialize database first (for crash-safe recording metadata)
  initializeDatabase();

  // Initialize telemetry (support ID + error handlers)
  initializeTelemetry();

  // Register all IPC handlers before creating window
  registerAllIpcHandlers();

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const mainWindow = new BrowserWindow({
    width,
    height,
    webPreferences: {
      preload: getPreloadPath(),
      webSecurity: false,
      // The GPU engine's preview needs this.
      //
      // A `VideoFrame` cannot cross a contextBridge, so the shared texture has
      // to be received and drawn inside preload. `sharedTexture` is not part
      // of the polyfilled electron module a sandboxed preload gets, and a
      // sandboxed preload cannot require a relative file either -- so with the
      // default (`sandbox: true`) the engine bridge cannot load at all.
      //
      // This is much weaker than what the original prototype needed, which was
      // `nodeIntegration: true` plus `contextIsolation: false`. Context
      // isolation stays on: the main world still has no Node, and still only
      // sees what the contextBridge exposes.
      sandbox: false,
    },
    frame: false,
  });

  mainWindow.maximize();

  if (isDevelopment()) {
    mainWindow.loadURL('http://localhost:5123');
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist-react/index.html'));
  }

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Main] Renderer process gone:', details);
  });

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error('[Main] Renderer failed to load:', {
        errorCode,
        errorDescription,
        validatedURL,
      });
    },
  );

  mainWindow.webContents.on('unresponsive', () => {
    console.error('[Main] Renderer became unresponsive');
  });

  // Initialize IPC with window reference and start polling
  initializeWithWindow(mainWindow);

  // Create system tray
  createTray(mainWindow);

  // Fire-and-forget: reports which adapter the engine and Chromium each landed
  // on, and warns if they diverge. Only meaningful once the GPU process is up.
  void checkGpuMatch();
});
