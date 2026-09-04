/**
 * Exporter IPC Handlers
 *
 * Exposes exporter service functionality to the renderer process.
 * Handles:
 * - Starting/cancelling exports
 * - Progress tracking and events
 * - Exports folder management
 */

import fs from 'node:fs';

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

  // Open specific file with the default system app
  ipcMain.handle('exporter:open-file', async (_event, filePath: string) => {
    const errorMessage = await shell.openPath(filePath);
    return errorMessage.length === 0;
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

  /**
   * How big a finished export is.
   *
   * The engine writes its output itself, so unlike the canvas path there is no
   * buffer in the renderer to measure. 0 for a file that is not there, because
   * a missing size is a cosmetic problem and should not fail an export that
   * otherwise succeeded.
   */
  ipcMain.handle('exporter:file-size', async (_event, filePath: string) => {
    try {
      return (await fs.promises.stat(filePath)).size;
    } catch {
      return 0;
    }
  });
}
