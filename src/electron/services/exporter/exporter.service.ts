import * as fs from 'fs';
import * as path from 'path';

import { activeSettings } from '../../automation/active-settings.js';
import type { ExportConfig, ExportResult } from '../../types/exporter.types.js';
import type { Project } from '../../types/project.types.js';
import * as editorService from '../editor.service.js';

function ensureExportsDirectory(project: Project, configuredOutputFolder?: string): string {
  const recordingDir = path.dirname(project.projectFolderPath);
  const defaultExportsDir = path.join(recordingDir, 'exports');
  // While the Automation API is on, an integration may have pointed exports
  // somewhere (video-workflow's Media/Footage); with it off this is always null.
  const apiOutputFolder = activeSettings()?.value('export.outputDir') ?? null;
  const exportsDir = configuredOutputFolder || apiOutputFolder || defaultExportsDir;

  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }

  return exportsDir;
}

function resolveOutputExtension(config: Pick<ExportConfig, 'format'>): string {
  // Currently only MP4 is supported, keep this centralized for future formats.
  return config.format === 'mp4' ? 'mp4' : 'mp4';
}

function buildOutputPath(project: Project, config: ExportConfig): string {
  const exportsDir = ensureExportsDirectory(project, config.outputFolder);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = resolveOutputExtension(config);

  let baseNameRaw = config.outputFilename || project.name || 'export';
  baseNameRaw = baseNameRaw.replace(new RegExp(`\\.${ext}$`, 'i'), '');
  const sanitizedName = baseNameRaw.replace(/[^a-zA-Z0-9-_]/g, '_');

  return path.join(exportsDir, `${sanitizedName}_${timestamp}.${ext}`);
}

/**
 * Get exports folder path for current project
 */
export function getExportsFolder(): string | null {
  const project = editorService.getActiveProject();
  if (!project) return null;
  return ensureExportsDirectory(project);
}

/**
 * Resolve the final output path using the same naming strategy as the built-in exporter.
 */
export function resolveOutputPath(config: ExportConfig): string | null {
  const project = editorService.getActiveProject();
  if (!project) {
    return null;
  }

  return buildOutputPath(project, config);
}

/**
 * Persist renderer-produced export bytes to disk.
 */
export function writeOutputFile(outputPath: string, data: ArrayBuffer): ExportResult {
  try {
    if (!outputPath) {
      return { success: false, error: 'Output path is required' };
    }

    const parentDir = path.dirname(outputPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const buffer = Buffer.from(data);
    fs.writeFileSync(outputPath, buffer);

    return {
      success: true,
      outputPath,
      fileSize: buffer.byteLength,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to write output file',
    };
  }
}
