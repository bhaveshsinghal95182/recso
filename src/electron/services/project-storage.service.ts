/**
 * ProjectStorageService — Manages .recso folder structure for projects.
 *
 * Folder structure:
 * /recordings/{uuid}/
 * ├── .recso/                    # Project metadata folder
 * │   ├── project.json           # Edit decisions, cursor config, zoom
 * │   ├── spritesheet-screen.png # Timeline thumbnails for the screen recording
 * │   ├── spritesheet-webcam.png # Timeline thumbnails for the camera sidecar
 * │   ├── spritesheets.json      # Spritesheet metadata, keyed by source
 * │   └── thumbnail.jpg          # Project cover thumbnail
 * ├── raw.mp4                    # Original recording
 * └── exports/                   # Exported videos
 */

import fs from 'fs';
import path from 'path';

import type { Project } from '../types/project.types.js';
import type {
  SpritesheetMeta,
  SpritesheetsBySource,
  SpritesheetSource,
} from '../types/spritesheet.types.js';
import { projectEvents } from './recorder-events.js';
import { spritesheetImageName } from './spritesheet-plan.js';

const RECSO_FOLDER = '.recso';
const PROJECT_FILE = 'project.json';
/**
 * Deliberately not `spritesheet.json`. That name held a single sheet in the
 * pre-by-source shape, and a sidecar left over from a build that wrote one
 * would parse cleanly into something with no `source` on it. A new filename
 * means the old file is simply never read rather than half-understood.
 */
const SPRITESHEET_META = 'spritesheets.json';
const THUMBNAIL_FILE = 'thumbnail.jpg';
const EXPORTS_FOLDER = 'exports';

/**
 * Get the .recso folder path for a recording
 */
export function getProjectFolderPath(recordingDir: string): string {
  return path.join(recordingDir, RECSO_FOLDER);
}

/**
 * Initialize the .recso project folder structure
 */
export function initProjectFolder(recordingDir: string): string {
  const projectFolder = getProjectFolderPath(recordingDir);

  // Create .recso folder
  if (!fs.existsSync(projectFolder)) {
    fs.mkdirSync(projectFolder, { recursive: true });
    console.log('[ProjectStorage] Created project folder:', projectFolder);
  }

  // Create exports folder
  const exportsFolder = path.join(recordingDir, EXPORTS_FOLDER);
  if (!fs.existsSync(exportsFolder)) {
    fs.mkdirSync(exportsFolder, { recursive: true });
  }

  return projectFolder;
}

/**
 * Save project metadata to .recso/project.json
 */
export function saveProjectMetadata(project: Project): boolean {
  try {
    const projectFile = path.join(project.projectFolderPath, PROJECT_FILE);
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2), 'utf-8');
    console.log('[ProjectStorage] Saved project metadata:', projectFile);
    projectEvents.emit('saved', {
      projectDir: path.dirname(project.projectFolderPath),
      name: project.name,
      recordingId: project.recordingId,
    });
    return true;
  } catch (error) {
    console.error('[ProjectStorage] Failed to save project:', error);
    return false;
  }
}

/**
 * Load project metadata from .recso/project.json
 */
export function loadProjectMetadata(recordingDir: string): Project | null {
  try {
    const projectFile = path.join(recordingDir, RECSO_FOLDER, PROJECT_FILE);
    if (!fs.existsSync(projectFile)) {
      return null;
    }
    const content = fs.readFileSync(projectFile, 'utf-8');
    return JSON.parse(content) as Project;
  } catch (error) {
    console.error('[ProjectStorage] Failed to load project:', error);
    return null;
  }
}

/**
 * Check if a project exists for a recording
 */
export function projectExists(recordingDir: string): boolean {
  const projectFile = path.join(recordingDir, RECSO_FOLDER, PROJECT_FILE);
  return fs.existsSync(projectFile);
}

/**
 * Where a source's sheet PNG lives.
 *
 * Same name `spritesheetTargets` builds, from the same helper, so the planner
 * and the storage layer cannot drift into looking for different files.
 */
export function getSpritesheetImagePath(projectFolder: string, source: SpritesheetSource): string {
  return path.join(projectFolder, spritesheetImageName(source));
}

/**
 * Get the spritesheet metadata sidecar path
 */
export function getSpritesheetMetaPath(projectFolder: string): string {
  return path.join(projectFolder, SPRITESHEET_META);
}

const SPRITESHEET_SOURCES: SpritesheetSource[] = ['screen', 'webcam'];

/**
 * Whether a parsed JSON value is a usable sheet for `source`.
 *
 * The sidecar is a file on disk that a user can edit, truncate, or leave half
 * written if the process died mid-save. Every number is checked because a NaN
 * `columns` does not throw anywhere -- it silently makes every frame lookup
 * return garbage coordinates, which shows up as a blank filmstrip nobody can
 * explain.
 */
function isUsableMeta(value: unknown, source: SpritesheetSource): value is SpritesheetMeta {
  if (!value || typeof value !== 'object') return false;

  const meta = value as Record<string, unknown>;
  if (meta.source !== source) return false;
  if (typeof meta.imagePath !== 'string' || meta.imagePath.length === 0) return false;

  const positive = ['frameCount', 'intervalMs', 'frameWidth', 'frameHeight', 'columns', 'rows'];
  for (const key of positive) {
    const candidate = meta[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) {
      return false;
    }
  }

  const nonNegative = ['totalDurationMs', 'sourceSizeBytes', 'sourceModifiedMs'];
  for (const key of nonNegative) {
    const candidate = meta[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
      return false;
    }
  }

  return true;
}

/**
 * Save the project's sheets, keyed by source.
 */
export function saveSpritesheets(projectFolder: string, sheets: SpritesheetsBySource): boolean {
  try {
    const metaPath = getSpritesheetMetaPath(projectFolder);
    fs.writeFileSync(metaPath, JSON.stringify(sheets, null, 2), 'utf-8');
    console.log('[ProjectStorage] Saved spritesheet meta:', metaPath);
    return true;
  } catch (error) {
    console.error('[ProjectStorage] Failed to save spritesheet meta:', error);
    return false;
  }
}

/**
 * Load the project's sheets, keyed by source.
 *
 * Never throws and never returns a partially trusted object: anything that does
 * not validate is dropped, which at worst means that source gets regenerated.
 */
export function loadSpritesheets(projectFolder: string): SpritesheetsBySource {
  try {
    const metaPath = getSpritesheetMetaPath(projectFolder);
    if (!fs.existsSync(metaPath)) {
      return {};
    }

    const parsed: unknown = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const sheets: SpritesheetsBySource = {};
    for (const source of SPRITESHEET_SOURCES) {
      const candidate = (parsed as Record<string, unknown>)[source];
      if (isUsableMeta(candidate, source)) {
        sheets[source] = candidate;
      }
    }

    return sheets;
  } catch (error) {
    console.error('[ProjectStorage] Failed to load spritesheet meta:', error);
    return {};
  }
}

/**
 * Get the thumbnail path
 */
export function getThumbnailPath(projectFolder: string): string {
  return path.join(projectFolder, THUMBNAIL_FILE);
}

/**
 * Get the exports folder path
 */
export function getExportsFolderPath(recordingDir: string): string {
  return path.join(recordingDir, EXPORTS_FOLDER);
}

/**
 * Generate project thumbnail
 * STUB: This will be implemented in Phase 11 with FFmpeg
 */
export async function generateThumbnail(
  _videoPath: string,
  _projectFolder: string,
  _timeMs: number = 0,
): Promise<string | null> {
  // TODO: Implement with FFmpeg in Phase 11
  // FFmpeg command: ffmpeg -i video.mp4 -ss 0 -vframes 1 thumbnail.jpg
  console.log('[ProjectStorage] generateThumbnail is a stub - requires FFmpeg (Phase 11)');
  return null;
}
