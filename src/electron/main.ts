import { app, BrowserWindow } from 'electron';

import path from 'path';

import { getPreloadPath } from './path-resolver.js';
import { pollResources } from './resource-manager.js';
import { isDevelopment } from './util.js';

app.on('ready', () => {
  const mainWindow = new BrowserWindow({
    webPreferences: { preload: getPreloadPath() },
  });

  if (isDevelopment()) {
    mainWindow.loadURL('http://localhost:5123');
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist-react/index.html'));
  }

  pollResources();
});
