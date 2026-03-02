import { ipcMain } from 'electron';

import { getSupportId, logRendererError } from '../services/telemetry/telemetry.service.js';

export function registerTelemetryHandlers() {
  /** Return the device's persistent support ID to the renderer */
  ipcMain.handle('telemetry:get-support-id', () => {
    return getSupportId();
  });

  /** Receive error reports from the renderer process */
  ipcMain.on(
    'telemetry:log-error',
    (
      _event,
      error: { message: string; stack?: string; componentStack?: string; source?: string },
    ) => {
      logRendererError(error);
    },
  );
}
