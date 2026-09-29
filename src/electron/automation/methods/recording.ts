/**
 * `settings.*`, `devices.list`, `recording.*` and `sources.forget`.
 */

import { requireAbsolutePath } from '../paths.js';
import { AutomationError, ErrorCode } from '../protocol.js';
import type { MethodRegistry } from '../registry.js';
import type { JsonSchema } from '../schema.js';
import type { AutomationServices, RecordingStartRequest } from '../services.js';
import {
  type AutomationSettings,
  SETTING_KEYS,
  SETTING_SCHEMAS,
  type SettingKey,
} from '../settings-store.js';
import { recordingStateSchema } from './core.js';

const noParams = { type: 'object', additionalProperties: false } as const;

const settingsObject: JsonSchema = {
  type: 'object',
  properties: SETTING_SCHEMAS,
  additionalProperties: false,
};

const deviceSchema: JsonSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, label: { type: 'string' }, isDefault: { type: 'boolean' } },
  required: ['id', 'label', 'isDefault'],
};

/** Paths in settings must be absolute; returns the patch with them normalised. */
function checkSettingPaths(
  platform: NodeJS.Platform,
  values: Partial<AutomationSettings>,
): Partial<AutomationSettings> {
  const checked = { ...values };
  if (typeof checked['recording.outputDir'] === 'string') {
    checked['recording.outputDir'] = requireAbsolutePath(
      platform,
      checked['recording.outputDir'],
      'recording.outputDir',
    );
  }
  if (typeof checked['export.outputDir'] === 'string') {
    checked['export.outputDir'] = requireAbsolutePath(
      platform,
      checked['export.outputDir'],
      'export.outputDir',
    );
  }
  return checked;
}

/** A file name recso can use as a folder and a file on every platform. */
function checkFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed || /[<>:"/\\|?*\u0000-\u001f]/.test(trimmed) || /^\.+$/.test(trimmed)) {
    throw new AutomationError(
      'invalid_params',
      `fileName must be a plain name without path separators or <>:"|?*: ${fileName}`,
      { code: ErrorCode.InvalidParams },
    );
  }
  return trimmed;
}

export function registerRecordingMethods(
  registry: MethodRegistry,
  services: AutomationServices,
): void {
  const { platform, settings } = services;

  registry.register<{ keys?: SettingKey[] }, { values: Partial<AutomationSettings> }>({
    name: 'settings.get',
    description:
      'Read recorder and export settings: all of them, or the keys asked for. These are what the next recording or export uses when a call does not override them.',
    params: {
      type: 'object',
      properties: { keys: { type: 'array', items: { type: 'string', enum: SETTING_KEYS } } },
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: { values: settingsObject },
      required: ['values'],
    },
    handler: ({ keys }) => {
      const all = settings.get();
      if (!keys) return { values: all };
      return {
        values: Object.fromEntries(
          keys.map((key) => [key, all[key]]),
        ) as Partial<AutomationSettings>,
      };
    },
  });

  registry.register<
    { values: Partial<AutomationSettings> },
    { values: AutomationSettings; changed: SettingKey[] }
  >({
    name: 'settings.set',
    description:
      "Change recorder and export settings. recso's recorder shows the change straight away. Values last until recso quits, so set them again after launching it.",
    params: {
      type: 'object',
      properties: { values: { ...settingsObject } },
      required: ['values'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: { values: settingsObject, changed: { type: 'array', items: { type: 'string' } } },
      required: ['values', 'changed'],
    },
    handler: ({ values }) => {
      const changed = settings.set(checkSettingPaths(platform, values));
      return { values: settings.get(), changed: Object.keys(changed) as SettingKey[] };
    },
  });

  registry.register({
    name: 'devices.list',
    description:
      'Microphones, cameras and capture sources, with the ids recording.start and settings.set accept.',
    params: noParams,
    result: {
      type: 'object',
      properties: {
        microphones: { type: 'array', items: deviceSchema },
        cameras: { type: 'array', items: deviceSchema },
        sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              kind: { type: 'string', enum: ['screen', 'window', 'portal'] },
              isPrimary: { type: 'boolean' },
            },
            required: ['id', 'name', 'kind', 'isPrimary'],
          },
        },
        rememberedSource: { type: ['boolean', 'null'] },
      },
      required: ['microphones', 'cameras', 'sources', 'rememberedSource'],
    },
    platforms: {
      linux:
        'One source, kind "portal": the desktop asks which screen or window when recording starts, unless a source is remembered (rememberedSource).',
      win32:
        'The primary screen and each open window, by id; recording.start({ sourceId }) records one without asking. rememberedSource is null.',
    },
    handler: () => services.listDevices(),
  });

  registry.register<RecordingStartRequest, unknown>({
    name: 'recording.start',
    description:
      "Start recording. recso's recorder comes to the front and shows the recording as if its button had been pressed; either side can stop it. Unset options come from the settings. Returns once capture is running.",
    params: {
      type: 'object',
      properties: {
        sourceId: {
          type: 'string',
          description: 'From devices.list; the primary screen when unset.',
        },
        outputDir: { type: 'string', description: 'Absolute. Overrides recording.outputDir.' },
        fileName: {
          type: 'string',
          description: 'Name of the recording folder and video, without extension.',
        },
        systemAudio: { type: 'boolean' },
        mic: { type: 'boolean' },
        micDeviceId: { type: ['string', 'null'] },
        camera: { type: 'boolean' },
        cameraDeviceId: { type: ['string', 'null'] },
        rememberSource: {
          type: 'boolean',
          description:
            'Linux: let the desktop remember the chosen screen or window, so later recordings with rememberSource skip the picker until sources.forget.',
        },
      },
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        recordingId: { type: 'string' },
        sourceId: { type: 'string' },
        videoPath: { type: 'string' },
        rememberedSource: { type: 'boolean' },
      },
      required: ['recordingId', 'sourceId', 'videoPath'],
    },
    platforms: {
      linux:
        'Without a remembered source the desktop shows its picker and the call waits for the choice (cancelling fails with reason "cancelled").',
      win32: 'rememberSource is not supported and is ignored: sources are chosen by id.',
    },
    handler: (params) => {
      const request: RecordingStartRequest = { ...params };
      if (request.outputDir !== undefined) {
        request.outputDir = requireAbsolutePath(platform, request.outputDir, 'outputDir');
      }
      if (request.fileName !== undefined) {
        request.fileName = checkFileName(request.fileName);
      }
      return services.startRecording(request);
    },
  });

  registry.register({
    name: 'recording.stop',
    description:
      'Stop the recording and wait until its file is finalised. Returns the new project (its folder holds .recso/project.json), the video, the camera video if one was recorded, the duration and the number of clicks tracked.',
    params: noParams,
    result: {
      type: 'object',
      properties: {
        recordingId: { type: 'string' },
        projectDir: { type: 'string' },
        videoPath: { type: 'string' },
        cameraPath: { type: ['string', 'null'] },
        durationMs: { type: 'number' },
        clicks: { type: 'integer' },
      },
      required: ['recordingId', 'projectDir', 'videoPath', 'cameraPath', 'durationMs', 'clicks'],
    },
    handler: () => services.stopRecording(),
  });

  for (const name of ['recording.pause', 'recording.resume'] as const) {
    registry.register({
      name,
      description: `${name === 'recording.pause' ? 'Pause' : 'Resume'} the recording. Not supported yet by recso's native recorder: always fails with reason "not_supported".`,
      params: noParams,
      result: recordingStateSchema,
      handler: () => {
        if (services.recordingState().state === 'idle') {
          throw new AutomationError('not_recording', 'nothing is recording');
        }
        throw new AutomationError(
          'not_supported',
          "recso's native recorder cannot pause yet; stop and start a new recording instead",
        );
      },
    });
  }

  registry.register({
    name: 'recording.state',
    description: 'Whether recso is idle, recording or stopping, and for how long.',
    params: noParams,
    result: recordingStateSchema,
    handler: () => services.recordingState(),
  });

  registry.register({
    name: 'sources.forget',
    description:
      'Forget the screen or window remembered with rememberSource, so the next recording asks again.',
    params: noParams,
    result: {
      type: 'object',
      properties: { forgotten: { type: 'boolean' } },
      required: ['forgotten'],
    },
    platforms: { win32: 'Nothing is remembered on Windows; always { forgotten: false }.' },
    handler: () => ({ forgotten: services.forgetSource() }),
  });
}
