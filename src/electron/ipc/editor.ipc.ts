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
import type {
  CropConfig,
  CursorConfig,
  CursorRegionOverride,
  TimelineLayerId,
  TimelineVisibilityMode,
  WebcamOverlayConfig,
  ZoomConfig,
  ZoomSource,
} from '../types/project.types.js';
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

  // Upsert cursor region image override
  ipcMain.handle(
    'editor:update-cursor-region-override',
    async (_event, cursorOverride: CursorRegionOverride) => {
      return editorService.updateCursorRegionOverride(cursorOverride);
    },
  );

  // Replace all cursor region image overrides
  ipcMain.handle(
    'editor:replace-cursor-region-overrides',
    async (_event, cursorOverrides: CursorRegionOverride[]) => {
      return editorService.replaceCursorRegionOverrides(cursorOverrides);
    },
  );

  // Remove cursor region image override
  ipcMain.handle('editor:remove-cursor-region-override', async (_event, regionId: string) => {
    return editorService.removeCursorRegionOverride(regionId);
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

  // Update crop configuration
  ipcMain.handle('editor:update-crop-config', async (_event, config: CropConfig | null) => {
    return editorService.updateCropConfig(config);
  });

  // Update webcam overlay configuration
  ipcMain.handle(
    'editor:update-webcam-overlay',
    async (_event, config: Partial<WebcamOverlayConfig>) => {
      return editorService.updateWebcamOverlay(config);
    },
  );

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

  // Get timeline layer visibility/order configuration
  ipcMain.handle('editor:get-timeline-layers', async () => {
    return editorService.getTimelineLayers();
  });

  // Update timeline layer visibility
  ipcMain.handle(
    'editor:update-timeline-layer-visibility',
    async (_event, layerId: TimelineLayerId, visible: boolean) => {
      return editorService.updateTimelineLayerVisibility(layerId, visible);
    },
  );

  // Update timeline layer hide mode
  ipcMain.handle(
    'editor:update-timeline-layer-hide-mode',
    async (_event, layerId: TimelineLayerId, hideMode: TimelineVisibilityMode) => {
      return editorService.updateTimelineLayerHideMode(layerId, hideMode);
    },
  );

  // Reorder timeline layers by id
  ipcMain.handle('editor:reorder-timeline-layers', async (_event, layerIds: TimelineLayerId[]) => {
    return editorService.reorderTimelineLayers(layerIds);
  });

  // Get all zoom regions
  ipcMain.handle('editor:get-zoom-regions', async () => {
    return editorService.getZoomRegions();
  });

  // Get zoom regions for a specific source timeline
  ipcMain.handle('editor:get-zoom-regions-by-source', async (_event, source: ZoomSource) => {
    return editorService.getZoomRegionsBySource(source);
  });

  // Add a new zoom region
  ipcMain.handle('editor:add-zoom-region', async (_event, zoom: ZoomRegion) => {
    return editorService.addZoomRegion(zoom);
  });

  // Add a new zoom region for a specific source timeline
  ipcMain.handle(
    'editor:add-zoom-region-by-source',
    async (_event, source: ZoomSource, zoom: ZoomRegion) => {
      return editorService.addZoomRegionBySource(source, zoom);
    },
  );

  // Remove a zoom region
  ipcMain.handle('editor:remove-zoom-region', async (_event, zoomId: string) => {
    return editorService.removeZoomRegion(zoomId);
  });

  // Remove a zoom region for a specific source timeline
  ipcMain.handle(
    'editor:remove-zoom-region-by-source',
    async (_event, source: ZoomSource, zoomId: string) => {
      return editorService.removeZoomRegionBySource(source, zoomId);
    },
  );

  // Update a zoom region
  ipcMain.handle('editor:update-zoom-region', async (_event, zoom: ZoomRegion) => {
    return editorService.updateZoomRegion(zoom);
  });

  // Update a zoom region for a specific source timeline
  ipcMain.handle(
    'editor:update-zoom-region-by-source',
    async (_event, source: ZoomSource, zoom: ZoomRegion) => {
      return editorService.updateZoomRegionBySource(source, zoom);
    },
  );

  // Update multiple zoom regions at once (bulk update)
  ipcMain.handle('editor:update-zoom-regions', async (_event, zooms: ZoomRegion[]) => {
    return editorService.updateZoomRegions(zooms);
  });

  // Update multiple zoom regions for a specific source timeline
  ipcMain.handle(
    'editor:update-zoom-regions-by-source',
    async (_event, source: ZoomSource, zooms: ZoomRegion[]) => {
      return editorService.updateZoomRegionsBySource(source, zooms);
    },
  );

  // Get mouse events for the active project's recording
  ipcMain.handle('editor:get-mouse-events', async () => {
    const project = editorService.getActiveProject();
    if (!project) return [];
    return mouseTrackerService.getEventsForRecording(project.recordingId);
  });

  console.log('[EditorIPC] Handlers registered');
}
