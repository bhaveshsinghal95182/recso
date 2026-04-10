/**
 * Exporter IPC Handlers
 *
 * Exposes exporter service functionality to the renderer process.
 * Handles:
 * - Starting/cancelling exports
 * - Progress tracking and events
 * - Exports folder management
 */

import { ipcMain, shell } from 'electron';

import * as exporterService from '../services/exporter/exporter.service.js';
import type { ExportConfig, ExportProgress } from '../types/exporter.types.js';

/** Store progress listeners for cleanup */
const progressListeners = new Map<string, (progress: ExportProgress) => void>();

/**
 * Register all exporter IPC handlers
 */
export function registerExporterHandlers(): void {
  // Start export with configuration
  ipcMain.handle('exporter:start', async (_event, config: ExportConfig) => {
    return exporterService.startExport(config);
  });

  // Cancel ongoing export
  ipcMain.handle('exporter:cancel', async () => {
    return exporterService.cancelExport();
  });

  // Get current progress
  ipcMain.handle('exporter:get-progress', async () => {
    return exporterService.getProgress();
  });

  // Get current export state
  ipcMain.handle('exporter:get-state', async () => {
    return exporterService.getState();
  });

  // Get current job info
  ipcMain.handle('exporter:get-job', async () => {
    return exporterService.getCurrentJob();
  });

  // Get exports folder path
  ipcMain.handle('exporter:get-exports-folder', async () => {
    return exporterService.getExportsFolder();
  });

  // Open exports folder in system file explorer
  ipcMain.handle('exporter:open-exports-folder', async () => {
    const folder = exporterService.getExportsFolder();
    if (folder) {
      await shell.openPath(folder);
      return true;
    }
    return false;
  });

  // Open specific file in system file explorer
  ipcMain.handle('exporter:show-in-folder', async (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
    return true;
  });

  // Resolve an output path using exporter naming rules
  ipcMain.handle('exporter:resolve-output-path', async (_event, config: ExportConfig) => {
    return exporterService.resolveOutputPath(config);
  });

  // Persist renderer-produced export bytes to disk
  ipcMain.handle(
    'exporter:write-output-file',
    async (_event, outputPath: string, data: ArrayBuffer) => {
      return exporterService.writeOutputFile(outputPath, data);
    },
  );

  // Subscribe to progress events
  ipcMain.on('exporter:subscribe-progress', (event) => {
    const webContentsId = event.sender.id.toString();

    // Create listener for this renderer
    const listener = (progress: ExportProgress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('exporter:progress', progress);
      } else {
        // Clean up if renderer is destroyed
        exporterService.exporterEvents.off('progress', listener);
        progressListeners.delete(webContentsId);
      }
    };

    // Store and register listener
    progressListeners.set(webContentsId, listener);
    exporterService.exporterEvents.on('progress', listener);

    console.log('[ExporterIPC] Subscribed to progress:', webContentsId);
  });

  // Unsubscribe from progress events
  ipcMain.on('exporter:unsubscribe-progress', (event) => {
    const webContentsId = event.sender.id.toString();
    const listener = progressListeners.get(webContentsId);

    if (listener) {
      exporterService.exporterEvents.off('progress', listener);
      progressListeners.delete(webContentsId);
      console.log('[ExporterIPC] Unsubscribed from progress:', webContentsId);
    }
  });

  // Toggle keep-intermediate debug mode
  ipcMain.handle('exporter:set-keep-intermediate', async (_event, keep: boolean) => {
    exporterService.setKeepIntermediate(keep);
    return true;
  });

  // Get keep-intermediate state
  ipcMain.handle('exporter:get-keep-intermediate', async () => {
    return exporterService.getKeepIntermediate();
  });
}
