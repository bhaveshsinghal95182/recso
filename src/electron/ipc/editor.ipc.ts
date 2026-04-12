/**
 * EditorIPC — IPC handlers for the non-linear editor.
 *
 * Exposes EditorService to renderer:
 * - Project management (create, load, save)
 * - Frame state queries (cursor position at time)
 * - Configuration updates (cursor, zoom)
 * - Spritesheet metadata access
 */

import { dialog, ipcMain } from 'electron';

import * as editorService from '../services/editor.service.js';
import { mouseTrackerService } from '../services/mouse-tracker.service.js';
import * as projectStorage from '../services/project-storage.service.js';
import type { CutRegion } from '../types/cut.types.js';
import type { CursorConfig, ZoomConfig } from '../types/project.types.js';
import type { ZoomRegion } from '../types/zoom.types.js';

/**
 * Register all editor IPC handlers
 */
export function registerEditorHandlers(): void {
  // Create a new project from a recording
  ipcMain.handle('editor:create-project', async (_event, recordingId: string) => {
    return editorService.createProject(recordingId);
  });

  // Load an existing project from recording directory
  ipcMain.handle('editor:load-project', async (_event, recordingDir: string) => {
    return editorService.loadProject(recordingDir);
  });

  // Save the active project
  ipcMain.handle('editor:save-project', async () => {
    return editorService.saveProject();
  });

  // Get the active project
  ipcMain.handle('editor:get-project', async () => {
    return editorService.getActiveProject();
  });

  // Close the active project
  ipcMain.handle('editor:close-project', async () => {
    editorService.closeProject();
    return true;
  });

  // Get frame state at a specific time (for preview)
  ipcMain.handle('editor:get-frame-state', async (_event, timeMs: number) => {
    return editorService.getFrameState(timeMs);
  });

  // Get cursor position at a specific time
  ipcMain.handle('editor:get-cursor-at', async (_event, timeMs: number) => {
    return editorService.getCursorAtTime(timeMs);
  });

  // Update cursor configuration
  ipcMain.handle('editor:update-cursor-config', async (_event, config: Partial<CursorConfig>) => {
    editorService.updateCursorConfig(config);
    return editorService.getActiveProject()?.cursorConfig;
  });

  // Open file picker for custom cursor image
  ipcMain.handle('editor:show-cursor-picker', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select Cursor Image',
      properties: ['openFile'],
      filters: [{ name: 'Cursor Images', extensions: ['png', 'svg', 'jpg', 'jpeg', 'webp'] }],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  // Update zoom configuration
  ipcMain.handle('editor:update-zoom-config', async (_event, config: Partial<ZoomConfig>) => {
    editorService.updateZoomConfig(config);
    return editorService.getActiveProject()?.zoomConfig;
  });

  // Update project duration
  ipcMain.handle('editor:update-project-duration', async (_event, durationMs: number) => {
    return editorService.updateProjectDuration(durationMs);
  });

  // Check if a project exists for recording
  ipcMain.handle('editor:project-exists', async (_event, recordingDir: string) => {
    return projectStorage.projectExists(recordingDir);
  });

  // Get spritesheet metadata
  ipcMain.handle('editor:get-spritesheet-meta', async () => {
    const project = editorService.getActiveProject();
    return project?.spritesheetMeta ?? null;
  });

  // Get spritesheet image path
  ipcMain.handle('editor:get-spritesheet-path', async () => {
    const project = editorService.getActiveProject();
    if (!project) return null;
    return projectStorage.getSpritesheetImagePath(project.projectFolderPath);
  });

  // Generate spritesheet (stub - requires FFmpeg)
  ipcMain.handle('editor:generate-spritesheet', async (_event, intervalMs: number = 1000) => {
    const project = editorService.getActiveProject();
    if (!project) return null;

    const meta = await projectStorage.generateSpritesheet(
      project.rawVideoPath,
      project.projectFolderPath,
      intervalMs,
    );

    // Update project with new spritesheet meta
    if (meta) {
      // TODO: Update project.spritesheetMeta and save
    }

    return meta;
  });

  // Get all cut regions
  ipcMain.handle('editor:get-cuts', async () => {
    return editorService.getCuts();
  });

  // Add a new cut region
  ipcMain.handle('editor:add-cut', async (_event, cut: CutRegion) => {
    return editorService.addCut(cut);
  });

  // Remove a cut region
  ipcMain.handle('editor:remove-cut', async (_event, cutId: string) => {
    return editorService.removeCut(cutId);
  });

  // Update a cut region
  ipcMain.handle('editor:update-cut', async (_event, cut: CutRegion) => {
    return editorService.updateCut(cut);
  });

  // Get all zoom regions
  ipcMain.handle('editor:get-zoom-regions', async () => {
    return editorService.getZoomRegions();
  });

  // Add a new zoom region
  ipcMain.handle('editor:add-zoom-region', async (_event, zoom: ZoomRegion) => {
    return editorService.addZoomRegion(zoom);
  });

  // Remove a zoom region
  ipcMain.handle('editor:remove-zoom-region', async (_event, zoomId: string) => {
    return editorService.removeZoomRegion(zoomId);
  });

  // Update a zoom region
  ipcMain.handle('editor:update-zoom-region', async (_event, zoom: ZoomRegion) => {
    return editorService.updateZoomRegion(zoom);
  });

  // Update multiple zoom regions at once (bulk update)
  ipcMain.handle('editor:update-zoom-regions', async (_event, zooms: ZoomRegion[]) => {
    return editorService.updateZoomRegions(zooms);
  });

  // Get mouse events for the active project's recording
  ipcMain.handle('editor:get-mouse-events', async () => {
    const project = editorService.getActiveProject();
    if (!project) return [];
    return mouseTrackerService.getEventsForRecording(project.recordingId);
  });

  console.log('[EditorIPC] Handlers registered');
}
