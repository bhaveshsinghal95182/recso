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

import type {
  CursorConfig,
  FrameState,
  Project,
  Timeline,
  TransformedCursorPosition,
  ZoomConfig,
} from '../types/project.types.js';
import { DEFAULT_CURSOR_CONFIG, DEFAULT_ZOOM_CONFIG } from '../types/project.types.js';
import { getRecording } from './database.service.js';
import { type ClickEvent, mouseTrackerService } from './mouse-tracker.service.js';
import * as projectStorage from './project-storage.service.js';

// Active project (only one at a time)
let activeProject: Project | null = null;

// Cache for click events (key: recordingId)
const clickEventsCache = new Map<string, ClickEvent[]>();

/**
 * Create a new editing project from a recording
 */
export function createProject(recordingId: string): Project | null {
  const recording = getRecording(recordingId);
  if (!recording) {
    console.error('[EditorService] Recording not found:', recordingId);
    return null;
  }

  if (!recording.finalPath || !fs.existsSync(recording.finalPath)) {
    console.error('[EditorService] Recording file not found:', recording.finalPath);
    return null;
  }

  // Get the recording directory and init .recso folder
  const recordingDir = path.dirname(recording.finalPath);
  const projectFolderPath = projectStorage.initProjectFolder(recordingDir);

  // Try to load existing spritesheet metadata
  const spritesheetMeta = projectStorage.loadSpritesheetMeta(projectFolderPath);

  const project: Project = {
    id: randomUUID(),
    name: recording.fileName || 'Untitled Project',
    recordingId,
    projectFolderPath,
    rawVideoPath: recording.finalPath,
    videoDimensions: { width: 1920, height: 1080 }, // TODO: Extract from video metadata
    timeline: createDefaultTimeline(),
    cursorConfig: { ...DEFAULT_CURSOR_CONFIG },
    zoomConfig: { ...DEFAULT_ZOOM_CONFIG },
    spritesheetMeta,
    backgroundColor: '#000000',
    createdAt: Date.now(),
    modifiedAt: Date.now(),
  };

  // Save project metadata to .recso folder
  projectStorage.saveProjectMetadata(project);

  activeProject = project;
  console.log('[EditorService] Created project:', project.id);

  // Load click events
  loadClickEvents(recordingId);

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

    // Load click events
    loadClickEvents(project.recordingId);

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

  // Auto-save metadata
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
  const nearbyClick = clicks.find(
    (click) => click.timestampMs >= timeMs - windowMs && click.timestampMs <= timeMs + windowMs,
  );

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
