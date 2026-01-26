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

  ipcMain.handle('is-window-maximized', () => {
    const win = BrowserWindow.getFocusedWindow();
    return win?.isMaximized() ?? false;
  });
}

export function registerWindowEvents(win: BrowserWindow) {
  win.on('maximize', () => {
    win.webContents.send('window-maximized', true);
  });

  win.on('unmaximize', () => {
    win.webContents.send('window-maximized', false);
  });
}

export function setMainWindowRef(win: BrowserWindow) {
  mainWindowRef = win;
}
