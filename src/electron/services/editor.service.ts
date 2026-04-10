/**
 * EditorService — Core logic for the non-linear video editor.
 *
 * Responsibilities:
 * - Manage editing projects (create, load, save)
 * - Retrieve click events for cursor overlay
 * - Bridge between project storage and UI
 *
 * Simplified version without velocity interpolation.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { BackgroundPatternConfig } from '../types/background.types.js';
import type { CutRegion } from '../types/cut.types.js';
import type {
  CursorConfig,
  FrameState,
  Project,
  Timeline,
  TransformedCursorPosition,
  ZoomConfig,
} from '../types/project.types.js';
import { DEFAULT_CURSOR_CONFIG, DEFAULT_ZOOM_CONFIG } from '../types/project.types.js';
import type { ZoomRegion } from '../types/zoom.types.js';
import { findClosestEventInWindow } from '../util.js';
import * as CompositorService from './compositor.service.js';
import { getRecording } from './database.service.js';
import * as mediaMetadataService from './media-metadata.service.js';
import { type MouseEvent, mouseTrackerService } from './mouse-tracker.service.js';
import * as projectStorage from './project-storage.service.js';
import { upsertRecentProject } from './recent-projects.service.js';

// Active project (only one at a time)
let activeProject: Project | null = null;

// Cache for click events (key: recordingId)
const clickEventsCache = new Map<string, MouseEvent[]>();

/**
 * Create a new editing project from a recording
 */
export async function createProject(recordingId: string): Promise<Project | null> {
  const recording = getRecording(recordingId);
  if (!recording) {
    console.error('[EditorService] Recording not found:', recordingId);
    return null;
  }

  if (!recording.finalPath || !fs.existsSync(recording.finalPath)) {
    console.error('[EditorService] Recording file not found:', recording.finalPath);
    return null;
  }

  // Check if a project already exists for this recording — if so, load it
  // instead of creating a new one (preserves zoom regions, cuts, backgrounds)
  const recordingDir = path.dirname(recording.finalPath);
  if (projectStorage.projectExists(recordingDir)) {
    console.log('[EditorService] Found existing project, loading...');
    const existingProject = loadProject(recordingDir);
    if (existingProject) {
      return existingProject;
    }
    // If loading fails, fall through to create a new project
    console.warn('[EditorService] Failed to load existing project, creating new one');
  }

  // Probe video for metadata
  let metadata;
  try {
    metadata = await mediaMetadataService.probeVideoMetadata(recording.finalPath);
    console.log('[EditorService] Probed video metadata (MediaBunny):', metadata);
  } catch (err) {
    console.error('[EditorService] Failed to probe video:', err);
    // Fallback to defaults if probe fails
    metadata = { width: 1920, height: 1080, duration: 0 };
  }

  // Get the recording directory and init .recso folder
  const projectFolderPath = projectStorage.initProjectFolder(recordingDir);

  // Try to load existing spritesheet metadata
  const spritesheetMeta = projectStorage.loadSpritesheetMeta(projectFolderPath);

  const project: Project = {
    id: randomUUID(),
    name: recording.fileName || 'Untitled Project',
    recordingId,
    projectFolderPath,
    rawVideoPath: recording.finalPath,
    videoDimensions: { width: metadata.width, height: metadata.height },
    timeline: { ...createDefaultTimeline(), duration: metadata.duration * 1000 },
    cursorConfig: { ...DEFAULT_CURSOR_CONFIG },
    zoomConfig: { ...DEFAULT_ZOOM_CONFIG },
    spritesheetMeta,
    backgroundColor: '#000000',
    backgroundPattern: null,
    cuts: [],
    zoomRegions: [],
    createdAt: Date.now(),
    modifiedAt: Date.now(),
  };

  // Save project metadata to .recso folder
  projectStorage.saveProjectMetadata(project);

  activeProject = project;
  console.log('[EditorService] Created project:', project.id);

  // Load click events
  loadClickEvents(recordingId);

  // Track in recent projects
  upsertRecentProject({
    id: project.id,
    name: project.name,
    path: recordingDir,
    recordingId,
  });

  return project;
}

/**
 * Get the currently active project
 */
export function getActiveProject(): Project | null {
  return activeProject;
}

/**
 * Load a project from a recording directory (reads from .recso folder)
 */
export function loadProject(recordingDir: string): Project | null {
  try {
    const project = projectStorage.loadProjectMetadata(recordingDir);
    if (!project) {
      console.error('[EditorService] No project found in:', recordingDir);
      return null;
    }

    activeProject = project;

    // Sync compositor state
    try {
      CompositorService.setBackgroundColor(project.backgroundColor);
      CompositorService.setBackground(project.backgroundPath || null);
    } catch (err) {
      console.warn('[EditorService] Failed to sync compositor state on load:', err);
    }

    // Load click events
    loadClickEvents(project.recordingId);

    // Track in recent projects
    upsertRecentProject({
      id: project.id,
      name: project.name,
      path: recordingDir,
      recordingId: project.recordingId,
    });

    console.log('[EditorService] Loaded project:', project.id);
    return project;
  } catch (error) {
    console.error('[EditorService] Failed to load project:', error);
    return null;
  }
}

/**
 * Save the active project to .recso folder
 */
export function saveProject(): boolean {
  if (!activeProject) {
    console.error('[EditorService] No active project to save');
    return false;
  }

  activeProject.modifiedAt = Date.now();
  return projectStorage.saveProjectMetadata(activeProject);
}

/**
 * Update cursor configuration
 */
export function updateCursorConfig(config: Partial<CursorConfig>): void {
  if (!activeProject) return;

  activeProject.cursorConfig = { ...activeProject.cursorConfig, ...config };
  activeProject.modifiedAt = Date.now();
}

/**
 * Update zoom configuration
 */
export function updateZoomConfig(config: Partial<ZoomConfig>): void {
  if (!activeProject) return;

  activeProject.zoomConfig = { ...activeProject.zoomConfig, ...config };
  activeProject.modifiedAt = Date.now();
}

/**
 * Update project duration (e.g. from video metadata)
 */
export function updateProjectDuration(durationMs: number): boolean {
  if (!activeProject) return false;

  activeProject.timeline.duration = durationMs;
  activeProject.modifiedAt = Date.now();
  console.log('[EditorService] Updated project duration:', durationMs);

  // Auto-save metadata with new duration
  projectStorage.saveProjectMetadata(activeProject);
  return true;
}

/**
 * Update project background color
 */
export function updateBackgroundColor(color: string): boolean {
  if (!activeProject) return false;

  activeProject.backgroundColor = color;
  activeProject.modifiedAt = Date.now();

  try {
    CompositorService.setBackgroundColor(color);
  } catch (err) {
    console.warn('[EditorService] Failed to update compositor background color:', err);
  }

  // Auto-save metadata
  projectStorage.saveProjectMetadata(activeProject);
  return true;
}

/**
 * Update project background pattern
 */
export function updateBackgroundPattern(pattern: BackgroundPatternConfig | null): boolean {
  if (!activeProject) return false;

  activeProject.backgroundPattern = pattern;
  activeProject.modifiedAt = Date.now();

  // Auto-save metadata
  projectStorage.saveProjectMetadata(activeProject);
  return true;
}

/**
 * Update project background image path
 */
export function updateBackgroundPath(imagePath: string | null): boolean {
  if (!activeProject) return false;

  activeProject.backgroundPath = imagePath ?? undefined;
  activeProject.modifiedAt = Date.now();

  try {
    CompositorService.setBackground(imagePath);
  } catch (err) {
    console.warn('[EditorService] Failed to update compositor background path:', err);
  }

  // Auto-save metadata
  projectStorage.saveProjectMetadata(activeProject);
  return true;
}

/**
 * Get all cut regions
 */
export function getCuts(): CutRegion[] {
  if (!activeProject) return [];
  return activeProject.cuts || [];
}

/**
 * Add a new cut region
 */
export function addCut(cut: CutRegion): boolean {
  if (!activeProject) return false;

  // Initialize cuts array if not present
  if (!activeProject.cuts) {
    activeProject.cuts = [];
  }

  // Check for overlaps and merge if needed
  activeProject.cuts.push(cut);
  activeProject.cuts.sort((a, b) => a.startMs - b.startMs);
  activeProject.modifiedAt = Date.now();

  projectStorage.saveProjectMetadata(activeProject);
  return true;
}

/**
 * Remove a cut region by ID
 */
export function removeCut(cutId: string): boolean {
  if (!activeProject || !activeProject.cuts) return false;

  const index = activeProject.cuts.findIndex((c) => c.id === cutId);
  if (index === -1) return false;

  activeProject.cuts.splice(index, 1);
  activeProject.modifiedAt = Date.now();

  projectStorage.saveProjectMetadata(activeProject);
  return true;
}

/**
 * Update a cut region
 */
export function updateCut(cut: CutRegion): boolean {
  if (!activeProject || !activeProject.cuts) return false;

  const index = activeProject.cuts.findIndex((c) => c.id === cut.id);
  if (index === -1) return false;

  activeProject.cuts[index] = cut;
  activeProject.cuts.sort((a, b) => a.startMs - b.startMs);
  activeProject.modifiedAt = Date.now();

  projectStorage.saveProjectMetadata(activeProject);
  return true;
}

/**
 * Get all zoom regions
 */
export function getZoomRegions(): ZoomRegion[] {
  if (!activeProject) return [];
  return activeProject.zoomRegions || [];
}

/**
 * Add a new zoom region
 */
export function addZoomRegion(zoom: ZoomRegion): boolean {
  if (!activeProject) return false;

  // Initialize zoomRegions array if not present
  if (!activeProject.zoomRegions) {
    activeProject.zoomRegions = [];
  }

  activeProject.zoomRegions.push(zoom);
  activeProject.zoomRegions.sort((a, b) => a.startMs - b.startMs);
  activeProject.modifiedAt = Date.now();

  projectStorage.saveProjectMetadata(activeProject);
  return true;
}

/**
 * Remove a zoom region by ID
 */
export function removeZoomRegion(zoomId: string): boolean {
  if (!activeProject || !activeProject.zoomRegions) return false;

  const index = activeProject.zoomRegions.findIndex((z) => z.id === zoomId);
  if (index === -1) return false;

  activeProject.zoomRegions.splice(index, 1);
  activeProject.modifiedAt = Date.now();

  projectStorage.saveProjectMetadata(activeProject);
  return true;
}

/**
 * Update a zoom region
 */
export function updateZoomRegion(zoom: ZoomRegion): boolean {
  if (!activeProject || !activeProject.zoomRegions) return false;

  const index = activeProject.zoomRegions.findIndex((z) => z.id === zoom.id);
  if (index === -1) return false;

  activeProject.zoomRegions[index] = zoom;
  activeProject.zoomRegions.sort((a, b) => a.startMs - b.startMs);
  activeProject.modifiedAt = Date.now();

  projectStorage.saveProjectMetadata(activeProject);
  return true;
}

/**
 * Update multiple zoom regions at once (bulk update)
 */
export function updateZoomRegions(zooms: ZoomRegion[]): boolean {
  if (!activeProject || !activeProject.zoomRegions) return false;

  for (const zoom of zooms) {
    const index = activeProject.zoomRegions.findIndex((z) => z.id === zoom.id);
    if (index !== -1) {
      activeProject.zoomRegions[index] = zoom;
    }
  }

  activeProject.zoomRegions.sort((a, b) => a.startMs - b.startMs);
  activeProject.modifiedAt = Date.now();

  projectStorage.saveProjectMetadata(activeProject);
  return true;
}

/**
 * Get the frame state at a specific time.
 * Returns click indicator if a click occurred near this time.
 */
export function getFrameState(timeMs: number): FrameState {
  if (!activeProject) {
    return { timeMs, cursor: null };
  }

  const cursor = getCursorAtTime(timeMs);

  return {
    timeMs,
    cursor,
  };
}

/**
 * Get click event near a specific time (for click indicator overlay)
 * Returns the closest click within a 500ms window
 */
export function getCursorAtTime(timeMs: number): TransformedCursorPosition | null {
  if (!activeProject) return null;

  const { recordingId } = activeProject;
  const clicks = clickEventsCache.get(recordingId);

  if (!clicks || clicks.length === 0) {
    return null;
  }

  // Find a click within 500ms window
  const windowMs = 500;
  const nearbyClick = findClosestEventInWindow(clicks, timeMs, windowMs);

  if (!nearbyClick) {
    return null;
  }

  // Calculate fade based on distance from click time
  const distance = Math.abs(nearbyClick.timestampMs - timeMs);
  const fadeProgress = distance / windowMs; // 0 at click, 1 at edge

  return {
    x: nearbyClick.x,
    y: nearbyClick.y,
    visible: true,
    eventType: 'click',
    button: nearbyClick.button,
    isInterpolated: false,
    fadeProgress, // For animation
  };
}

/**
 * Load click events for a recording into cache
 */
function loadClickEvents(recordingId: string): void {
  const events = mouseTrackerService.getEventsForRecording(recordingId);
  clickEventsCache.set(recordingId, events);
  console.log(`[EditorService] Loaded ${events.length} click events for recording:`, recordingId);
}

/**
 * Create a default timeline with a single video clip
 */
function createDefaultTimeline(): Timeline {
  return {
    duration: 0, // Will be updated when video metadata is loaded
    tracks: [
      {
        id: 'video-track',
        type: 'video',
        clips: [],
        enabled: true,
      },
      {
        id: 'cursor-track',
        type: 'cursor',
        clips: [],
        enabled: true,
      },
    ],
  };
}

/**
 * Close the active project
 */
export function closeProject(): void {
  if (activeProject) {
    clickEventsCache.delete(activeProject.recordingId);
    activeProject = null;
    console.log('[EditorService] Closed project');
  }
}
