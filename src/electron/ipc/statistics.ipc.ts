import { type BrowserWindow, ipcMain } from 'electron';

import { StatsService } from '../services/stats.service.js';

const POLLING_INTERVAL = 500;

export function registerStatisticsHandlers() {
  // Handle request for static system data
  ipcMain.handle('get-static-data', async () => {
    return StatsService.getStaticData();
  });
}

export function startStatisticsPolling(mainWindow: BrowserWindow) {
  setInterval(async () => {
    const stats = await StatsService.getStatistics();
    mainWindow.webContents.send('statistics', stats);
  }, POLLING_INTERVAL);
}
