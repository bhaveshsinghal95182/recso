import { ipcMain } from 'electron';

import { mouseTrackerService } from '../services/mouse-tracker.service.js';

export function registerDebugHandlers() {
  ipcMain.handle('debug:get-mouse-status', () => {
    return {
      isTracking: mouseTrackerService.isCurrentlyTracking(),
      recordingId: mouseTrackerService.getCurrentRecordingId(),
    };
  });
}
