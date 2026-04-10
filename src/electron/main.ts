import { app, BrowserWindow, screen } from 'electron';

// APPX/MSIX Store apps launch with cwd = C:\WINDOWS\system32 (read-only).
// Redirect to writable userData folder before anything else runs.
if (app.isPackaged) {
  process.chdir(app.getPath('userData'));
}

import path from 'path';

import { initializeWithWindow, registerAllIpcHandlers } from './ipc/index.js';
import { initializeDatabase } from './services/database.service.js';
import { initializeTelemetry } from './services/telemetry/telemetry.service.js';
import { createTray } from './services/tray.service.js';
import { initializeLogging } from './utils/logger.js';
import { getPreloadPath } from './path-resolver.js';
import { isDevelopment } from './util.js';

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
    },
    frame: false,
  });

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
});
