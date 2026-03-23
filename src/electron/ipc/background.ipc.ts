/**
 * BackgroundIPC — IPC handlers for background configuration.
 *
 * Handles:
 * - Background color updates
 * - Background pattern updates
 * - Background state management
 */

import { ipcMain } from 'electron';

import * as editorService from '../services/editor.service.js';
import type { BackgroundPatternConfig } from '../types/background.types.js';

/**
 * Register all background IPC handlers
 */
export function registerBackgroundHandlers(): void {
  /**
   * Update background color for the active project
   * Accepts: color string (hex, rgb, etc.)
   */
  ipcMain.handle('background:update-color', async (_event, color: string) => {
    try {
      const result = editorService.updateBackgroundColor(color);
      return { success: result, color };
    } catch (err) {
      console.error('[BackgroundIPC] updateBackgroundColor error:', err);
      throw err;
    }
  });

  /**
   * Update background pattern for the active project
   * Accepts: BackgroundPatternConfig object or null
   */
  ipcMain.handle(
    'background:update-pattern',
    async (_event, pattern: BackgroundPatternConfig | null) => {
      try {
        const result = editorService.updateBackgroundPattern(pattern);
        return { success: result, pattern };
      } catch (err) {
        console.error('[BackgroundIPC] updateBackgroundPattern error:', err);
        throw err;
      }
    },
  );

  /**
   * Update background image path for the active project
   * Accepts: absolute path string or null to clear
   */
  ipcMain.handle('background:update-path', async (_event, imagePath: string | null) => {
    try {
      const result = editorService.updateBackgroundPath(imagePath);
      return { success: result, path: imagePath };
    } catch (err) {
      console.error('[BackgroundIPC] updateBackgroundPath error:', err);
      throw err;
    }
  });

  /**
   * Get current background configuration for the active project
   */
  ipcMain.handle('background:get-config', async () => {
    const project = editorService.getActiveProject();
    if (!project) {
      return { backgroundPath: null, backgroundColor: '#ffffff', backgroundPattern: null };
    }
    return {
      backgroundPath: project.backgroundPath || null,
      backgroundColor: project.backgroundColor,
      backgroundPattern: project.backgroundPattern,
    };
  });

  console.log('[BackgroundIPC] Handlers registered');
}
