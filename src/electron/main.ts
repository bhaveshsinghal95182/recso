import { app, BrowserWindow, screen } from 'electron';

import path from 'path';

import { initializeWithWindow, registerAllIpcHandlers } from './ipc/index.js';
import { initializeDatabase } from './services/database.service.js';
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
    webPreferences: { preload: getPreloadPath() },
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
});
