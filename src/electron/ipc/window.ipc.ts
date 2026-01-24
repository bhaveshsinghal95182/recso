import { BrowserWindow, ipcMain } from 'electron';

import { hideToTray } from '../services/tray.service.js';

let mainWindowRef: BrowserWindow | null = null;

export function registerWindowHandlers() {
  ipcMain.on('close-window', () => {
    BrowserWindow.getFocusedWindow()?.close();
  });

  ipcMain.on('minimize-window', () => {
    BrowserWindow.getFocusedWindow()?.minimize();
  });

  ipcMain.on('maximize-window', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  ipcMain.on('hide-to-tray', () => {
    if (mainWindowRef) {
      hideToTray(mainWindowRef);
    }
  });
}

export function setMainWindowRef(win: BrowserWindow) {
  mainWindowRef = win;
}
