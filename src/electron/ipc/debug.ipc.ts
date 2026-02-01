import { ipcMain } from 'electron';

import { mouseTrackerService } from '../services/mouse-tracker.service.js';

export function registerDebugHandlers() {
  ipcMain.handle('debug:get-mouse-status', () => {
    return mouseTrackerService.getDebugStatus();
  });
}
