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
import type { ExportConfig } from '../types/exporter.types.js';

/**
 * Register all exporter IPC handlers
 */
export function registerExporterHandlers(): void {
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
}
