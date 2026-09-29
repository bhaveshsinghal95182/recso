/**
 * `api.*` and `app.*`: what this recso is and what it can do right now.
 */

import { API_VERSION, type MethodRegistry } from '../registry.js';
import type { JsonSchema } from '../schema.js';
import type { AutomationServices } from '../services.js';

const noParams = { type: 'object', additionalProperties: false } as const;

export const recordingStateSchema: JsonSchema = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['idle', 'recording', 'paused', 'stopping'] },
    recordingId: { type: ['string', 'null'] },
    durationMs: { type: 'number' },
    bytesWritten: { type: 'number' },
  },
  required: ['state', 'recordingId', 'durationMs', 'bytesWritten'],
};

export function registerCoreMethods(registry: MethodRegistry, services: AutomationServices): void {
  registry.register({
    name: 'api.version',
    description: 'The API contract version (major.minor) and the recso version.',
    params: noParams,
    result: {
      type: 'object',
      properties: { api: { type: 'string' }, app: { type: 'string' } },
      required: ['api', 'app'],
    },
    handler: () => ({ api: API_VERSION, app: services.appVersion }),
  });

  registry.register({
    name: 'api.describe',
    description:
      'Every method with its description and JSON Schemas for params and result, and every event with its payload schema.',
    params: noParams,
    result: {
      type: 'object',
      properties: {
        api: { type: 'string' },
        app: { type: 'string' },
        platform: { type: 'string' },
        methods: { type: 'array' },
        events: { type: 'array' },
      },
      required: ['api', 'app', 'platform', 'methods', 'events'],
    },
    handler: () => ({
      api: API_VERSION,
      app: services.appVersion,
      platform: services.platform,
      methods: registry.describeMethods(),
      events: registry.describeEvents(),
    }),
  });

  registry.register({
    name: 'app.status',
    description:
      'The recso version and platform, whether the video engine loaded and which encoders it can export with, the recording state, and the project open in the editor.',
    params: noParams,
    result: {
      type: 'object',
      properties: {
        api: { type: 'string' },
        app: { type: 'string' },
        platform: { type: 'string' },
        socket: { type: 'string' },
        engine: {
          type: 'object',
          properties: {
            available: { type: 'boolean' },
            encoders: { type: 'array', items: { type: 'string' } },
          },
          required: ['available', 'encoders'],
        },
        recording: recordingStateSchema,
        editor: {
          type: ['object', 'null'],
          properties: { projectDir: { type: 'string' }, name: { type: 'string' } },
        },
      },
      required: ['api', 'app', 'platform', 'socket', 'engine', 'recording', 'editor'],
    },
    platforms: {
      linux: 'encoders: "nvenc" when an NVIDIA driver with NVENC is present, and "openh264".',
      win32: 'encoders: the Media Foundation H.264 encoders on this machine.',
    },
    handler: () => {
      const available = services.engineAvailable();
      return {
        api: API_VERSION,
        app: services.appVersion,
        platform: services.platform,
        socket: services.transportPath,
        engine: { available, encoders: available ? services.videoEncoders() : [] },
        recording: services.recordingState(),
        editor: services.editorProject(),
      };
    },
  });

  registry.register({
    name: 'app.show',
    description:
      "Bring recso's window to the front (restoring it from the tray). Launching recso when it is not running is the CLI's job: recso-cli --launch.",
    params: noParams,
    result: { type: 'object', properties: { shown: { type: 'boolean' } }, required: ['shown'] },
    handler: () => {
      services.showWindow();
      return { shown: true };
    },
  });
}
