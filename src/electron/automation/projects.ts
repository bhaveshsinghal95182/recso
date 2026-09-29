/**
 * Read the small project inventory exposed by the Automation API.
 * Filesystem access is injectable so callers can test the inventory without Electron.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AutomationError } from './protocol.js';

export interface ProjectExportFile {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface ProjectSummary {
  projectDir: string;
  name: string;
  recordingId: string;
  videoPath: string;
  cameraPath: string | null;
  durationMs: number;
  width: number;
  height: number;
  createdAt: string;
  modifiedAt: string;
  thumbnailPath: string | null;
  exports: ProjectExportFile[];
}

export interface ProjectFs {
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: 'utf8'): string;
  readdirSync(
    p: string,
    options: { withFileTypes: true },
  ): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  statSync(p: string): { size: number; mtimeMs: number; isDirectory(): boolean };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function readProjectSummary(projectDir: string, projectFs: ProjectFs = fs): ProjectSummary {
  const projectPath = path.join(projectDir, '.recso', 'project.json');
  if (!projectFs.existsSync(projectPath)) {
    throw new AutomationError(
      'project_not_found',
      `no recso project in ${projectDir} (expected .recso/project.json)`,
    );
  }

  let project: unknown;
  try {
    project = JSON.parse(projectFs.readFileSync(projectPath, 'utf8'));
  } catch {
    throw new AutomationError('invalid_project', `invalid project.json in ${projectDir}`);
  }
  if (
    !record(project) ||
    typeof project.name !== 'string' ||
    typeof project.recordingId !== 'string' ||
    typeof project.rawVideoPath !== 'string'
  ) {
    throw new AutomationError('invalid_project', `invalid project fields in ${projectDir}`);
  }

  const videoPath = project.rawVideoPath;
  const extension = path.extname(videoPath);
  const cameraCandidate = path.join(
    path.dirname(videoPath),
    `${path.basename(videoPath, extension)}_camera${extension}`,
  );
  const thumbnailCandidate = path.join(projectDir, '.recso', 'thumbnail.jpg');
  const fallbackTime = projectFs.statSync(projectPath).mtimeMs;
  const dimensions = record(project.videoDimensions) ? project.videoDimensions : {};
  const timeline = record(project.timeline) ? project.timeline : {};
  const exportsDir = path.join(projectDir, 'exports');
  const exports: ProjectExportFile[] = [];
  if (projectFs.existsSync(exportsDir) && projectFs.statSync(exportsDir).isDirectory()) {
    for (const entry of projectFs.readdirSync(exportsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.mp4$/i.test(entry.name)) continue;
      const exportPath = path.join(exportsDir, entry.name);
      const stat = projectFs.statSync(exportPath);
      exports.push({
        path: exportPath,
        sizeBytes: stat.size,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
      });
    }
    exports.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  return {
    projectDir,
    name: project.name,
    recordingId: project.recordingId,
    videoPath,
    cameraPath: projectFs.existsSync(cameraCandidate) ? cameraCandidate : null,
    durationMs: numberField(timeline.duration),
    width: numberField(dimensions.width),
    height: numberField(dimensions.height),
    createdAt: new Date(
      typeof project.createdAt === 'number' ? project.createdAt : fallbackTime,
    ).toISOString(),
    modifiedAt: new Date(
      typeof project.modifiedAt === 'number' ? project.modifiedAt : fallbackTime,
    ).toISOString(),
    thumbnailPath: projectFs.existsSync(thumbnailCandidate) ? thumbnailCandidate : null,
    exports,
  };
}

export function listProjectsInDir(
  dir: string,
  options: { limit?: number } = {},
  projectFs: ProjectFs = fs,
): ProjectSummary[] {
  if (!projectFs.existsSync(dir) || !projectFs.statSync(dir).isDirectory()) {
    throw new AutomationError('not_found', `no such directory: ${dir}`);
  }
  const projects: ProjectSummary[] = [];
  for (const entry of projectFs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const projectDir = path.join(dir, entry.name);
    if (!projectFs.existsSync(path.join(projectDir, '.recso', 'project.json'))) continue;
    try {
      projects.push(readProjectSummary(projectDir, projectFs));
    } catch {
      // One damaged project must not hide the other projects in the directory.
    }
  }
  projects.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return projects.slice(0, Math.max(1, options.limit ?? 50));
}
