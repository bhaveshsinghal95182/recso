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
  CursorRegionOverride,
  FrameState,
  Project,
  Timeline,
  TimelineLayer,
  TimelineLayerId,
  TimelineVisibilityMode,
  TransformedCursorPosition,
  WebcamOverlayConfig,
  ZoomConfig,
  ZoomRegionsBySource,
  ZoomSource,
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

const DEFAULT_TIMELINE_LAYERS: TimelineLayer[] = [
  {
    id: 'main',
    label: 'Main Timeline',
    visible: true,
    order: 0,
    hideMode: 'editor-only',
  },
  {
    id: 'webcam',
    label: 'Webcam Timeline',
    visible: true,
    order: 1,
    hideMode: 'editor-only',
  },
  {
    id: 'zoom-screen',
    label: 'Screen Zoom Timeline',
    visible: true,
    order: 2,
    hideMode: 'editor-only',
  },
  {
    id: 'zoom-webcam',
    label: 'Webcam Zoom Timeline',
    visible: true,
    order: 3,
    hideMode: 'editor-only',
  },
  {
    id: 'cursor',
    label: 'Cursor Timeline',
    visible: true,
    order: 4,
    hideMode: 'editor-only',
  },
];

function sortZoomRegions(regions: ZoomRegion[]): ZoomRegion[] {
  return [...regions].sort((a, b) => a.startMs - b.startMs);
}

function createDefaultTimelineLayers(): TimelineLayer[] {
  return DEFAULT_TIMELINE_LAYERS.map((layer) => ({ ...layer }));
}

function normalizeTimelineLayers(layers?: TimelineLayer[]): TimelineLayer[] {
  const byId = new Map<TimelineLayerId, TimelineLayer>();
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      byId.set(layer.id, layer);
    }
  }

  const normalized: TimelineLayer[] = DEFAULT_TIMELINE_LAYERS.map((fallback): TimelineLayer => {
    const existing = byId.get(fallback.id);
    return {
      ...fallback,
      label:
        existing && typeof existing.label === 'string' && existing.label.trim().length > 0
          ? existing.label
          : fallback.label,
      visible: existing?.visible ?? fallback.visible,
      order: typeof existing?.order === 'number' ? existing.order : fallback.order,
      hideMode: existing?.hideMode === 'render-and-export' ? 'render-and-export' : 'editor-only',
    };
  });

  normalized.sort((a, b) => a.order - b.order);
  normalized.forEach((layer, index) => {
    layer.order = index;
  });

  return normalized;
}

function normalizeZoomRegionsBySource(project: Project): ZoomRegionsBySource {
  const legacyScreenZooms = Array.isArray(project.zoomRegions) ? project.zoomRegions : [];
  const currentBySource = project.zoomRegionsBySource;

  const screenRegions = Array.isArray(currentBySource?.screen)
    ? currentBySource.screen
    : legacyScreenZooms;
  const webcamRegions = Array.isArray(currentBySource?.webcam) ? currentBySource.webcam : [];

  return {
    screen: sortZoomRegions(screenRegions),
    webcam: sortZoomRegions(webcamRegions),
  };
}

function normalizeCutRegion(cut: CutRegion): CutRegion {
  return {
    ...cut,
    targets: {
      screen: cut.targets?.screen ?? true,
      webcam: cut.targets?.webcam ?? true,
    },
  };
}

function normalizeCuts(cuts: CutRegion[] | undefined): CutRegion[] {
  if (!Array.isArray(cuts)) return [];

  // Normalize and filter invalid ranges
  const normalized = [...cuts]
    .map((c) => {
      const n = normalizeCutRegion(c);
      return {
        ...n,
        startMs: Math.max(0, Math.min(Number(n.startMs) || 0, Number(n.endMs) || 0)),
        endMs: Math.max(0, Number(n.endMs) || 0),
      } as CutRegion;
    })
    .filter((c) => Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > c.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  // Merge overlapping or adjacent regions
  const merged: CutRegion[] = [];
  for (const cut of normalized) {
    if (merged.length === 0) {
      merged.push({ ...cut });
      continue;
    }

    const last = merged[merged.length - 1];
    // If overlapping or contiguous (touching), merge
    if (cut.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, cut.endMs);
      // Merge targets by union (if either targets a lane, keep it)
      last.targets = {
        screen: (last.targets?.screen ?? true) || (cut.targets?.screen ?? true),
        webcam: (last.targets?.webcam ?? true) || (cut.targets?.webcam ?? true),
      };
    } else {
      merged.push({ ...cut });
    }
  }

  return merged;
}

function normalizeCursorRegionOverride(
  cursorOverride: CursorRegionOverride,
): CursorRegionOverride | null {
  const regionId =
    typeof cursorOverride.regionId === 'string' ? cursorOverride.regionId.trim() : '';
  const imagePath =
    typeof cursorOverride.imagePath === 'string' ? cursorOverride.imagePath.trim() : '';
  const startMs = cursorOverride.startMs;
  const endMs = cursorOverride.endMs;

  if (
    !regionId ||
    !imagePath ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return null;
  }

  return {
    regionId,
    imagePath,
    startMs: Math.max(0, startMs),
    endMs: Math.max(0, endMs),
  };
}

function normalizeCursorRegionOverrides(
  cursorOverrides: CursorRegionOverride[] | undefined,
): CursorRegionOverride[] {
  if (!Array.isArray(cursorOverrides)) {
    return [];
  }

  const byRegionId = new Map<string, CursorRegionOverride>();
  for (const cursorOverride of cursorOverrides) {
    const normalized = normalizeCursorRegionOverride(cursorOverride);
    if (!normalized) {
      continue;
    }

    byRegionId.set(normalized.regionId, normalized);
  }

  return [...byRegionId.values()].sort((a, b) => {
    if (a.startMs !== b.startMs) {
      return a.startMs - b.startMs;
    }

    if (a.endMs !== b.endMs) {
      return a.endMs - b.endMs;
    }

    return a.regionId.localeCompare(b.regionId);
  });
}

function normalizeProjectData(project: Project): Project {
  project.cuts = normalizeCuts(project.cuts);
  project.cursorRegionOverrides = normalizeCursorRegionOverrides(project.cursorRegionOverrides);
  project.canvasBackgroundEnabled = project.canvasBackgroundEnabled !== false;

  const zoomRegionsBySource = normalizeZoomRegionsBySource(project);
  project.zoomRegionsBySource = zoomRegionsBySource;
  project.zoomRegions = zoomRegionsBySource.screen;
  project.timelineLayers = normalizeTimelineLayers(project.timelineLayers);

  return project;
}

function ensureZoomRegionsBySource(project: Project): ZoomRegionsBySource {
  const normalized = normalizeZoomRegionsBySource(project);
  project.zoomRegionsBySource = normalized;
  project.zoomRegions = normalized.screen;
  return normalized;
}

function ensureTimelineLayers(project: Project): TimelineLayer[] {
  const normalized = normalizeTimelineLayers(project.timelineLayers);
  project.timelineLayers = normalized;
  return normalized;
}

function persistProjectMutation(): void {
  if (!activeProject) {
    return;
  }

  activeProject.modifiedAt = Date.now();
  projectStorage.saveProjectMetadata(activeProject);
}

function inferWebcamSidecarPath(rawVideoPath: string): string | null {
  if (!rawVideoPath) {
    return null;
  }

  const parsed = path.parse(rawVideoPath);
  if (!parsed.dir || !parsed.name || !parsed.ext) {
    return null;
  }

  return path.join(parsed.dir, `${parsed.name}_camera${parsed.ext}`);
}

function createDefaultWebcamOverlay(rawVideoPath: string): Project['webcamOverlay'] {
  const webcamPath = inferWebcamSidecarPath(rawVideoPath);
  if (!webcamPath || !fs.existsSync(webcamPath)) {
    return null;
  }

  return {
    enabled: false,
    sourcePath: webcamPath,
    shape: 'rectangle-portrait',
    size: 'medium',
    aspectRatio: 3 / 4,
    heightRatio: 0.34,
    borderRadiusPx: 24,
  };
}

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

  const project: Project = normalizeProjectData({
    id: randomUUID(),
    name: recording.fileName || 'Untitled Project',
    recordingId,
    projectFolderPath,
    rawVideoPath: recording.finalPath,
    videoDimensions: { width: metadata.width, height: metadata.height },
    timeline: { ...createDefaultTimeline(), duration: metadata.duration * 1000 },
    cursorConfig: { ...DEFAULT_CURSOR_CONFIG },
    cursorRegionOverrides: [],
    zoomConfig: { ...DEFAULT_ZOOM_CONFIG },
    spritesheetMeta,
    backgroundColor: '#000000',
    backgroundPattern: null,
    canvasBackgroundEnabled: true,
    webcamOverlay: createDefaultWebcamOverlay(recording.finalPath),
    cuts: [],
    zoomRegions: [],
    zoomRegionsBySource: {
      screen: [],
      webcam: [],
    },
    timelineLayers: createDefaultTimelineLayers(),
    createdAt: Date.now(),
    modifiedAt: Date.now(),
  });

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
    const loadedProject = projectStorage.loadProjectMetadata(recordingDir);
    if (!loadedProject) {
      console.error('[EditorService] No project found in:', recordingDir);
      return null;
    }

    let project: Project = {
      ...loadedProject,
      cursorConfig: {
        ...DEFAULT_CURSOR_CONFIG,
        ...loadedProject.cursorConfig,
      },
      zoomConfig: {
        ...DEFAULT_ZOOM_CONFIG,
        ...loadedProject.zoomConfig,
      },
    };

    project = normalizeProjectData(project);

    if (!project.webcamOverlay) {
      project.webcamOverlay = createDefaultWebcamOverlay(project.rawVideoPath);
    } else if (!project.webcamOverlay.sourcePath) {
      const inferredPath = inferWebcamSidecarPath(project.rawVideoPath);
      if (inferredPath && fs.existsSync(inferredPath)) {
        project.webcamOverlay.sourcePath = inferredPath;
      }
    }

    activeProject = project;

    // Sync compositor state
    try {
      CompositorService.setBackgroundColor(project.backgroundColor);
      CompositorService.setBackground(project.backgroundPath || null);
      CompositorService.updateConfig({
        canvasBackgroundEnabled: project.canvasBackgroundEnabled !== false,
      });
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

  normalizeProjectData(activeProject);
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
 * Upsert an image override for a derived cursor timeline region.
 */
export function updateCursorRegionOverride(
  cursorOverride: CursorRegionOverride,
): CursorRegionOverride[] {
  if (!activeProject) {
    return [];
  }

  const normalized = normalizeCursorRegionOverride(cursorOverride);
  if (!normalized) {
    return normalizeCursorRegionOverrides(activeProject.cursorRegionOverrides).map((item) => ({
      ...item,
    }));
  }

  const existingOverrides = normalizeCursorRegionOverrides(activeProject.cursorRegionOverrides);
  const nextOverrides = normalizeCursorRegionOverrides([
    ...existingOverrides.filter((item) => item.regionId !== normalized.regionId),
    normalized,
  ]);

  activeProject.cursorRegionOverrides = nextOverrides;
  persistProjectMutation();

  return nextOverrides.map((item) => ({ ...item }));
}

/**
 * Replace all cursor timeline region overrides in a single mutation.
 */
export function replaceCursorRegionOverrides(
  cursorOverrides: CursorRegionOverride[],
): CursorRegionOverride[] {
  if (!activeProject) {
    return [];
  }

  const nextOverrides = normalizeCursorRegionOverrides(cursorOverrides);
  activeProject.cursorRegionOverrides = nextOverrides;
  persistProjectMutation();

  return nextOverrides.map((item) => ({ ...item }));
}

/**
 * Remove an image override for a derived cursor timeline region.
 */
export function removeCursorRegionOverride(regionId: string): CursorRegionOverride[] {
  if (!activeProject) {
    return [];
  }

  const normalizedRegionId = typeof regionId === 'string' ? regionId.trim() : '';
  const currentOverrides = normalizeCursorRegionOverrides(activeProject.cursorRegionOverrides);
  const nextOverrides = currentOverrides.filter((item) => item.regionId !== normalizedRegionId);

  activeProject.cursorRegionOverrides = nextOverrides;
  persistProjectMutation();

  return nextOverrides.map((item) => ({ ...item }));
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
 * Update webcam overlay configuration
 */
export function updateWebcamOverlay(
  config: Partial<WebcamOverlayConfig>,
): WebcamOverlayConfig | null | undefined {
  if (!activeProject) return undefined;

  const currentWebcam = activeProject.webcamOverlay ?? {
    enabled: false,
  };
  const nextWebcam: WebcamOverlayConfig = {
    ...currentWebcam,
    ...config,
  };

  if (!nextWebcam.sourcePath) {
    const inferredPath = inferWebcamSidecarPath(activeProject.rawVideoPath);
    if (inferredPath && fs.existsSync(inferredPath)) {
      nextWebcam.sourcePath = inferredPath;
    }
  }

  activeProject.webcamOverlay = nextWebcam;
  persistProjectMutation();

  return activeProject.webcamOverlay;
}

/**
 * Update project duration (e.g. from video metadata)
 */
export function updateProjectDuration(durationMs: number): boolean {
  if (!activeProject) return false;

  activeProject.timeline.duration = durationMs;
  console.log('[EditorService] Updated project duration:', durationMs);

  // Auto-save metadata with new duration
  persistProjectMutation();
  return true;
}

/**
 * Update project background color
 */
export function updateBackgroundColor(color: string): boolean {
  if (!activeProject) return false;

  activeProject.backgroundColor = color;

  try {
    CompositorService.setBackgroundColor(color);
  } catch (err) {
    console.warn('[EditorService] Failed to update compositor background color:', err);
  }

  // Auto-save metadata
  persistProjectMutation();
  return true;
}

/**
 * Update project background pattern
 */
export function updateBackgroundPattern(pattern: BackgroundPatternConfig | null): boolean {
  if (!activeProject) return false;

  activeProject.backgroundPattern = pattern;

  // Auto-save metadata
  persistProjectMutation();
  return true;
}

/**
 * Update project background image path
 */
export function updateBackgroundPath(imagePath: string | null): boolean {
  if (!activeProject) return false;

  activeProject.backgroundPath = imagePath ?? undefined;

  try {
    CompositorService.setBackground(imagePath);
  } catch (err) {
    console.warn('[EditorService] Failed to update compositor background path:', err);
  }

  // Auto-save metadata
  persistProjectMutation();
  return true;
}

/**
 * Update whether canvas background is enabled
 */
export function updateCanvasBackgroundEnabled(enabled: boolean): boolean {
  if (!activeProject) return false;

  activeProject.canvasBackgroundEnabled = enabled;

  try {
    CompositorService.updateConfig({ canvasBackgroundEnabled: enabled });
  } catch (err) {
    console.warn('[EditorService] Failed to update compositor canvas background enabled:', err);
  }

  // Auto-save metadata
  persistProjectMutation();
  return true;
}

export function getTimelineLayers(): TimelineLayer[] {
  if (!activeProject) {
    return createDefaultTimelineLayers();
  }

  return ensureTimelineLayers(activeProject).map((layer) => ({ ...layer }));
}

export function updateTimelineLayerVisibility(
  layerId: TimelineLayerId,
  visible: boolean,
): TimelineLayer[] | null {
  if (!activeProject) {
    return null;
  }

  const layers = ensureTimelineLayers(activeProject);
  const layer = layers.find((candidate) => candidate.id === layerId);
  if (!layer) {
    return null;
  }

  layer.visible = visible;
  persistProjectMutation();

  return layers.map((item) => ({ ...item }));
}

export function updateTimelineLayerHideMode(
  layerId: TimelineLayerId,
  hideMode: TimelineVisibilityMode,
): TimelineLayer[] | null {
  if (!activeProject) {
    return null;
  }

  const layers = ensureTimelineLayers(activeProject);
  const layer = layers.find((candidate) => candidate.id === layerId);
  if (!layer) {
    return null;
  }

  layer.hideMode = hideMode;
  persistProjectMutation();

  return layers.map((item) => ({ ...item }));
}

export function reorderTimelineLayers(layerIds: TimelineLayerId[]): TimelineLayer[] | null {
  if (!activeProject) {
    return null;
  }

  const layers = ensureTimelineLayers(activeProject);
  const uniqueRequested = Array.from(new Set(layerIds));
  const remainingIds = layers
    .map((layer) => layer.id)
    .filter((id) => !uniqueRequested.includes(id));
  const orderedIds = [...uniqueRequested, ...remainingIds];

  for (let index = 0; index < orderedIds.length; index += 1) {
    const layer = layers.find((candidate) => candidate.id === orderedIds[index]);
    if (layer) {
      layer.order = index;
    }
  }

  layers.sort((a, b) => a.order - b.order);
  persistProjectMutation();

  return layers.map((item) => ({ ...item }));
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
  activeProject.cuts.push(normalizeCutRegion(cut));
  activeProject.cuts = normalizeCuts(activeProject.cuts);
  persistProjectMutation();
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
  persistProjectMutation();
  return true;
}

/**
 * Update a cut region
 */
export function updateCut(cut: CutRegion): boolean {
  if (!activeProject || !activeProject.cuts) return false;

  const index = activeProject.cuts.findIndex((c) => c.id === cut.id);
  if (index === -1) return false;

  activeProject.cuts[index] = normalizeCutRegion(cut);
  activeProject.cuts = normalizeCuts(activeProject.cuts);
  persistProjectMutation();
  return true;
}

/**
 * Get all zoom regions
 */
export function getZoomRegions(): ZoomRegion[] {
  return getZoomRegionsBySource('screen');
}

/**
 * Get all zoom regions for a specific source timeline
 */
export function getZoomRegionsBySource(source: ZoomSource): ZoomRegion[] {
  if (!activeProject) return [];
  const zoomsBySource = ensureZoomRegionsBySource(activeProject);
  return sortZoomRegions(zoomsBySource[source]);
}

/**
 * Add a new zoom region
 */
export function addZoomRegion(zoom: ZoomRegion): boolean {
  return addZoomRegionBySource('screen', zoom);
}

/**
 * Add a new zoom region for a specific source timeline
 */
export function addZoomRegionBySource(source: ZoomSource, zoom: ZoomRegion): boolean {
  if (!activeProject) return false;

  const zoomsBySource = ensureZoomRegionsBySource(activeProject);
  zoomsBySource[source] = sortZoomRegions([...zoomsBySource[source], zoom]);
  activeProject.zoomRegionsBySource = zoomsBySource;
  activeProject.zoomRegions = zoomsBySource.screen;

  persistProjectMutation();
  return true;
}

/**
 * Remove a zoom region by ID
 */
export function removeZoomRegion(zoomId: string): boolean {
  return removeZoomRegionBySource('screen', zoomId);
}

/**
 * Remove a zoom region by ID for a specific source timeline
 */
export function removeZoomRegionBySource(source: ZoomSource, zoomId: string): boolean {
  if (!activeProject) return false;

  const zoomsBySource = ensureZoomRegionsBySource(activeProject);
  const index = zoomsBySource[source].findIndex((zoomRegion) => zoomRegion.id === zoomId);
  if (index === -1) return false;

  zoomsBySource[source].splice(index, 1);
  zoomsBySource[source] = sortZoomRegions(zoomsBySource[source]);
  activeProject.zoomRegionsBySource = zoomsBySource;
  activeProject.zoomRegions = zoomsBySource.screen;

  persistProjectMutation();
  return true;
}

/**
 * Update a zoom region
 */
export function updateZoomRegion(zoom: ZoomRegion): boolean {
  return updateZoomRegionBySource('screen', zoom);
}

/**
 * Update a zoom region for a specific source timeline
 */
export function updateZoomRegionBySource(source: ZoomSource, zoom: ZoomRegion): boolean {
  if (!activeProject) return false;

  const zoomsBySource = ensureZoomRegionsBySource(activeProject);
  const index = zoomsBySource[source].findIndex((zoomRegion) => zoomRegion.id === zoom.id);
  if (index === -1) return false;

  zoomsBySource[source][index] = zoom;
  zoomsBySource[source] = sortZoomRegions(zoomsBySource[source]);
  activeProject.zoomRegionsBySource = zoomsBySource;
  activeProject.zoomRegions = zoomsBySource.screen;

  persistProjectMutation();
  return true;
}

/**
 * Update multiple zoom regions at once (bulk update)
 */
export function updateZoomRegions(zooms: ZoomRegion[]): boolean {
  return updateZoomRegionsBySource('screen', zooms);
}

/**
 * Update multiple zoom regions at once for a specific source timeline.
 */
export function updateZoomRegionsBySource(source: ZoomSource, zooms: ZoomRegion[]): boolean {
  if (!activeProject) return false;

  const zoomsBySource = ensureZoomRegionsBySource(activeProject);

  for (const zoom of zooms) {
    const index = zoomsBySource[source].findIndex((zoomRegion) => zoomRegion.id === zoom.id);
    if (index !== -1) {
      zoomsBySource[source][index] = zoom;
    }
  }

  zoomsBySource[source] = sortZoomRegions(zoomsBySource[source]);
  activeProject.zoomRegionsBySource = zoomsBySource;
  activeProject.zoomRegions = zoomsBySource.screen;

  persistProjectMutation();
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
