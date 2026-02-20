import { app, BrowserWindow, screen } from 'electron';

import path from 'path';

import { initializeWithWindow, registerAllIpcHandlers } from './ipc/index.js';
import { initializeDatabase } from './services/database.service.js';
import { preWarm as preWarmRemotion } from './services/remotion-renderer.service.js';
import { createTray } from './services/tray.service.js';
import { getPreloadPath } from './path-resolver.js';
import { isDevelopment } from './util.js';

app.on('ready', () => {
  // Initialize database first (for crash-safe recording metadata)
  initializeDatabase();

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

  // Initialize IPC with window reference and start polling
  initializeWithWindow(mainWindow);

  // Create system tray
  createTray(mainWindow);

  // Pre-warm Remotion dependencies (Chrome path resolution)
  // Fire-and-forget: runs in background so export starts faster
  preWarmRemotion();
});
