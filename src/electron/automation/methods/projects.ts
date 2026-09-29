/**
 * `projects.*` and `export.*`.
 *
 * Exports run in a separate headless recso process, the one `--export-project`
 * has always started: the editor keeps a single active project, and loading
 * another in this process to export it would pull it out from under the user.
 */

import type { ExportEncoder, ExportJobStatus } from '../export-jobs.js';
import { pathModule, requireAbsolutePath } from '../paths.js';
import { listProjectsInDir, type ProjectSummary, readProjectSummary } from '../projects.js';
import { AutomationError, ErrorCode } from '../protocol.js';
import type { MethodRegistry } from '../registry.js';
import type { JsonSchema } from '../schema.js';
import type { AutomationServices } from '../services.js';
import { EXPORT_PRESETS } from '../settings-store.js';

const exportFileSchema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    sizeBytes: { type: 'number' },
    modifiedAt: { type: 'string' },
  },
  required: ['path', 'sizeBytes', 'modifiedAt'],
};

export const projectSchema: JsonSchema = {
  type: 'object',
  properties: {
    projectDir: { type: 'string' },
    name: { type: 'string' },
    recordingId: { type: 'string' },
    videoPath: { type: 'string' },
    cameraPath: { type: ['string', 'null'] },
    durationMs: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    createdAt: { type: 'string' },
    modifiedAt: { type: 'string' },
    thumbnailPath: { type: ['string', 'null'] },
    exports: { type: 'array', items: exportFileSchema },
  },
  required: ['projectDir', 'name', 'recordingId', 'videoPath', 'durationMs', 'exports'],
};

export const exportStatusSchema: JsonSchema = {
  type: 'object',
  properties: {
    exportId: { type: 'string' },
    projectDir: { type: 'string' },
    output: { type: 'string' },
    preset: { type: 'string' },
    encoder: { type: 'string', enum: ['auto', 'hardware', 'software'] },
    state: { type: 'string', enum: ['running', 'finished', 'failed', 'cancelled'] },
    percent: { type: 'number' },
    fps: { type: 'number' },
    etaSeconds: { type: ['number', 'null'] },
    phase: { type: 'string' },
    encoderName: { type: ['string', 'null'] },
    error: { type: ['string', 'null'] },
    startedAt: { type: 'string' },
    finishedAt: { type: ['string', 'null'] },
  },
  required: ['exportId', 'projectDir', 'output', 'state', 'percent'],
};

const projectDirParam: JsonSchema = {
  type: 'string',
  description: 'Absolute path of the project folder (the one holding .recso/project.json).',
};

const exportIdParams: JsonSchema & { type: 'object' } = {
  type: 'object',
  properties: { exportId: { type: 'string' } },
  required: ['exportId'],
  additionalProperties: false,
};

/** How long `wait: true` and `export.wait` hold by default. */
export const DEFAULT_EXPORT_WAIT_MS = 10 * 60_000;

/** A project name as a file name every platform accepts. */
export function exportBaseName(projectName: string): string {
  const cleaned = projectName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned || 'export';
}

/**
 * Where an export goes: the path asked for, else `<export.outputDir or the
 * project's exports folder>/<project name>.mp4`, numbered rather than
 * overwriting unless `overwrite` says so.
 */
export function resolveExportOutput(options: {
  platform: NodeJS.Platform;
  projectDir: string;
  projectName: string;
  requested?: string;
  outputDir: string | null;
  overwrite: boolean;
  exists: (path: string) => boolean;
}): string {
  const paths = pathModule(options.platform);
  if (options.requested !== undefined) {
    const output = requireAbsolutePath(options.platform, options.requested, 'output');
    if (!/\.mp4$/i.test(output)) {
      throw new AutomationError('invalid_params', `output must be an .mp4 file: ${output}`, {
        code: ErrorCode.InvalidParams,
      });
    }
    if (!options.overwrite && options.exists(output)) {
      throw new AutomationError(
        'output_exists',
        `${output} already exists; pass overwrite: true to replace it`,
      );
    }
    return output;
  }

  const dir = options.outputDir ?? paths.join(options.projectDir, 'exports');
  const base = exportBaseName(options.projectName);
  let candidate = paths.join(dir, `${base}.mp4`);
  for (let n = 2; !options.overwrite && options.exists(candidate); n++) {
    candidate = paths.join(dir, `${base}-${n}.mp4`);
  }
  return candidate;
}

function readProject(services: AutomationServices, projectDir: string): ProjectSummary {
  return readProjectSummary(requireAbsolutePath(services.platform, projectDir, 'projectDir'));
}

export function registerProjectMethods(
  registry: MethodRegistry,
  services: AutomationServices,
): void {
  const { platform, settings } = services;

  registry.register<{ dir?: string; limit?: number }, { projects: ProjectSummary[] }>({
    name: 'projects.list',
    description:
      "Projects, newest first: recso's recent projects, or with `dir` every project directly inside that folder (such as recording.outputDir).",
    params: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Absolute folder to scan instead of the recents.' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: { projects: { type: 'array', items: projectSchema } },
      required: ['projects'],
    },
    handler: ({ dir, limit = 20 }) => {
      if (dir !== undefined) {
        const folder = requireAbsolutePath(platform, dir, 'dir');
        return { projects: listProjectsInDir(folder, { limit }) };
      }
      const projects: ProjectSummary[] = [];
      for (const projectDir of services.recentProjectDirs(limit)) {
        try {
          projects.push(readProjectSummary(projectDir));
        } catch {
          // Moved or deleted since it was opened; the welcome screen shows it
          // as missing, the API just leaves it out.
        }
      }
      return { projects };
    },
  });

  registry.register<{ projectDir: string }, ProjectSummary>({
    name: 'projects.get',
    description:
      'One project: its video, camera video, duration, size, thumbnail and the exports in its exports folder.',
    params: {
      type: 'object',
      properties: { projectDir: projectDirParam },
      required: ['projectDir'],
      additionalProperties: false,
    },
    result: projectSchema,
    handler: ({ projectDir }) => readProject(services, projectDir),
  });

  registry.register<{ projectDir: string }, { opened: true; projectDir: string }>({
    name: 'projects.open',
    description: "Open a project in recso's editor and bring the window forward.",
    params: {
      type: 'object',
      properties: { projectDir: projectDirParam },
      required: ['projectDir'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: { opened: { type: 'boolean' }, projectDir: { type: 'string' } },
      required: ['opened', 'projectDir'],
    },
    handler: ({ projectDir }) => {
      const project = readProject(services, projectDir);
      if (services.recordingState().state !== 'idle') {
        throw new AutomationError(
          'busy',
          'recso is recording; stop the recording before opening a project',
        );
      }
      services.openProject(project.projectDir);
      return { opened: true, projectDir: project.projectDir };
    },
  });

  registry.register<
    {
      projectDir: string;
      output?: string;
      preset?: string;
      encoder?: ExportEncoder;
      overwrite?: boolean;
      wait?: boolean;
      timeoutMs?: number;
    },
    ExportJobStatus
  >({
    name: 'export.start',
    description:
      "Export a project to MP4 with its saved edits, as the editor's Export button would, without opening it. Returns at once with an exportId (follow it with export.progress, export.wait or the export.* events), or with wait: true once it has finished or timeoutMs has passed.",
    params: {
      type: 'object',
      properties: {
        projectDir: projectDirParam,
        output: {
          type: 'string',
          description:
            "Absolute .mp4 path. Default: <export.outputDir or the project's exports folder>/<project name>.mp4, numbered if taken.",
        },
        preset: {
          type: 'string',
          enum: [...EXPORT_PRESETS],
          description: 'Default: the export.preset setting.',
        },
        encoder: {
          type: 'string',
          enum: ['auto', 'hardware', 'software'],
          description: '"auto" (default) uses the GPU encoder when there is one.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Replace an existing output file. Without it, an existing output fails.',
        },
        wait: { type: 'boolean' },
        timeoutMs: { type: 'integer', minimum: 0 },
      },
      required: ['projectDir'],
      additionalProperties: false,
    },
    result: exportStatusSchema,
    platforms: {
      linux: 'encoder "hardware" is NVENC and fails without an NVIDIA GPU; "software" is openh264.',
      win32:
        "Media Foundation picks the encoder (hardware when it can); encoder is accepted but doesn't change it, and encoderName stays null.",
    },
    handler: async (params) => {
      const project = readProject(services, params.projectDir);
      const overwrite = params.overwrite === true;
      const output = resolveExportOutput({
        platform,
        projectDir: project.projectDir,
        projectName: project.name,
        requested: params.output,
        outputDir: settings.value('export.outputDir'),
        overwrite,
        exists: (candidate) =>
          services.pathExists(candidate) || services.exports.runningFor(candidate) !== null,
      });
      if (services.exports.runningFor(output)) {
        throw new AutomationError('output_busy', `another export is writing ${output}`);
      }
      const request = {
        projectDir: project.projectDir,
        output,
        preset: params.preset ?? settings.value('export.preset'),
        encoder: params.encoder ?? 'auto',
      };
      services.ensureDir(pathModule(platform).dirname(output));
      const status = services.exports.start(request, services.exportSpawnPlan(request));
      if (!params.wait) return status;
      return services.exports.wait(status.exportId, params.timeoutMs ?? DEFAULT_EXPORT_WAIT_MS);
    },
  });

  registry.register<{ exportId: string }, ExportJobStatus>({
    name: 'export.progress',
    description: 'Where an export is: its state, percent, speed and encoder.',
    params: exportIdParams,
    result: exportStatusSchema,
    handler: ({ exportId }) => services.exports.get(exportId),
  });

  registry.register<{ exportId: string }, ExportJobStatus>({
    name: 'export.cancel',
    description: 'Stop an export and delete its partial file.',
    params: exportIdParams,
    result: exportStatusSchema,
    handler: ({ exportId }) => services.exports.cancel(exportId),
  });

  registry.register<{ exportId: string; timeoutMs?: number }, ExportJobStatus>({
    name: 'export.wait',
    description:
      'Wait until an export finishes, fails or is cancelled, or until timeoutMs (default 10 minutes) passes; then return its status. For clients that cannot hold an event subscription.',
    params: {
      type: 'object',
      properties: { exportId: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 0 } },
      required: ['exportId'],
      additionalProperties: false,
    },
    result: exportStatusSchema,
    handler: ({ exportId, timeoutMs }) =>
      services.exports.wait(exportId, timeoutMs ?? DEFAULT_EXPORT_WAIT_MS),
  });
}
