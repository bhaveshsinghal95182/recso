/**
 * CompositorIPC — IPC handlers for compositor service.
 *
 * Provides:
 * - Background management (set/get)
 * - Webcam overlay layout calculation
 * - Configuration management
 *
 * The video's own layout is not here: the renderer computes it from the
 * project's `canvasPadding`, so preview and export always agree.
 */

import { dialog, ipcMain } from 'electron';

import * as CompositorService from '../services/compositor.service.js';
import type { Size, WebcamLayoutRequest } from '../types/compositor.types.js';

/**
 * Register all compositor IPC handlers
 */
export function registerCompositorHandlers(): void {
  // Get full configuration
  ipcMain.handle('compositor:get-config', async () => {
    return CompositorService.getConfig();
  });

  // Update configuration
  ipcMain.handle(
    'compositor:update-config',
    async (_event, updates: Parameters<typeof CompositorService.updateConfig>[0]) => {
      return CompositorService.updateConfig(updates);
    },
  );

  // Set background image
  ipcMain.handle('compositor:set-background', async (_event, imagePath: string | null) => {
    return CompositorService.setBackground(imagePath);
  });

  // Get background image path
  ipcMain.handle('compositor:get-background', async () => {
    return CompositorService.getBackground();
  });

  // Set background color
  ipcMain.handle('compositor:set-background-color', async (_event, color: string) => {
    CompositorService.setBackgroundColor(color);
    return true;
  });

  // Get background color
  ipcMain.handle('compositor:get-background-color', async () => {
    return CompositorService.getBackgroundColor();
  });

  // Set canvas size
  ipcMain.handle('compositor:set-canvas-size', async (_event, size: Size) => {
    CompositorService.setCanvasSize(size);
    return true;
  });

  // Get canvas size
  ipcMain.handle('compositor:get-canvas-size', async () => {
    return CompositorService.getCanvasSize();
  });

  // Calculate layout for webcam overlay
  ipcMain.handle(
    'compositor:calculate-webcam-layout',
    async (_event, canvasSize?: Size, request?: WebcamLayoutRequest) => {
      return CompositorService.calculateWebcamLayout(canvasSize, request);
    },
  );

  // Reset to defaults
  ipcMain.handle('compositor:reset-config', async () => {
    CompositorService.resetConfig();
    return CompositorService.getConfig();
  });

  // Show file picker for background image
  ipcMain.handle('compositor:show-background-picker', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select Background Image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const imagePath = result.filePaths[0];
    CompositorService.setBackground(imagePath);
    return imagePath;
  });

  console.log('[CompositorIPC] Handlers registered');
}
