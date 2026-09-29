/**
 * `events.subscribe`, `events.unsubscribe` and the events themselves.
 *
 * Events are notifications on the connection that subscribed. They report
 * what happened whoever caused it: a recording started from recso's own
 * button raises the same `recording.started` as one started over the API.
 */

import path from 'node:path';

import type {
  ProjectSavedEvent,
  RecordingStartedEvent,
  RecordingStoppedEvent,
} from '../../services/recorder-events.js';
import { AutomationError, ErrorCode } from '../protocol.js';
import type { MethodRegistry } from '../registry.js';
import type { JsonSchema } from '../schema.js';
import type { AutomationSettings } from '../settings-store.js';
import { exportStatusSchema } from './projects.js';

export interface RecordingStartedPayload {
  recordingId: string;
  sourceId: string;
  videoPath: string;
}

export interface RecordingStateChangedPayload {
  state: 'recording' | 'stopping' | 'idle';
  recordingId: string;
}

export interface RecordingStoppedPayload {
  recordingId: string;
  success: boolean;
  projectDir: string | null;
  videoPath: string | null;
  durationMs: number;
  clicks: number;
  error: string | null;
}

export interface SettingsChangedPayload {
  changed: string[];
  values: AutomationSettings;
}

export function recordingStartedPayload(event: RecordingStartedEvent): RecordingStartedPayload {
  const { config } = event;
  const extension = config.fileExtension ?? 'mp4';
  return {
    recordingId: event.recordingId,
    sourceId: config.sourceId,
    videoPath: path.join(config.outputDir, config.fileName, `${config.fileName}.${extension}`),
  };
}

export function recordingStoppedPayload(event: RecordingStoppedEvent): RecordingStoppedPayload {
  const { result } = event;
  const videoPath = result.success && result.filePath ? result.filePath : null;
  return {
    recordingId: event.recordingId,
    success: videoPath !== null,
    // The recording's folder is its project's folder.
    projectDir: videoPath ? path.dirname(videoPath) : null,
    videoPath,
    durationMs: result.media?.durationMs ?? 0,
    clicks: event.clicks,
    error: videoPath ? null : (result.error ?? 'the recording failed'),
  };
}

export function projectSavedPayload(event: ProjectSavedEvent): ProjectSavedEvent {
  return { projectDir: event.projectDir, name: event.name, recordingId: event.recordingId };
}

const EVENTS: { name: string; description: string; payload: JsonSchema }[] = [
  {
    name: 'recording.started',
    description: 'A recording started, from the API or from recso itself.',
    payload: {
      type: 'object',
      properties: {
        recordingId: { type: 'string' },
        sourceId: { type: 'string' },
        videoPath: { type: 'string' },
      },
      required: ['recordingId', 'sourceId', 'videoPath'],
    },
  },
  {
    name: 'recording.stateChanged',
    description: 'The recorder went to recording, stopping (finalising the file) or idle.',
    payload: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['recording', 'stopping', 'idle'] },
        recordingId: { type: 'string' },
      },
      required: ['state', 'recordingId'],
    },
  },
  {
    name: 'recording.stopped',
    description:
      'A recording was stopped and its file finalised (success true), or it failed. projectDir is the new project.',
    payload: {
      type: 'object',
      properties: {
        recordingId: { type: 'string' },
        success: { type: 'boolean' },
        projectDir: { type: ['string', 'null'] },
        videoPath: { type: ['string', 'null'] },
        durationMs: { type: 'number' },
        clicks: { type: 'integer' },
        error: { type: ['string', 'null'] },
      },
      required: ['recordingId', 'success', 'projectDir', 'videoPath'],
    },
  },
  {
    name: 'export.progress',
    description: 'An API export moved on (at most four times a second).',
    payload: exportStatusSchema,
  },
  {
    name: 'export.finished',
    description: 'An API export finished; output is the file.',
    payload: exportStatusSchema,
  },
  {
    name: 'export.failed',
    description: 'An API export failed; error says why.',
    payload: exportStatusSchema,
  },
  {
    name: 'project.saved',
    description:
      "A project's .recso/project.json was written: created after a recording or saved by the editor.",
    payload: {
      type: 'object',
      properties: {
        projectDir: { type: 'string' },
        name: { type: 'string' },
        recordingId: { type: 'string' },
      },
      required: ['projectDir', 'name', 'recordingId'],
    },
  },
  {
    name: 'settings.changed',
    description: 'Settings changed, over the API or in the recorder screen.',
    payload: {
      type: 'object',
      properties: {
        changed: { type: 'array', items: { type: 'string' } },
        values: { type: 'object' },
      },
      required: ['changed', 'values'],
    },
  },
];

export const EVENT_NAMES = EVENTS.map((event) => event.name);

export function registerEventMethods(registry: MethodRegistry): void {
  for (const event of EVENTS) registry.registerEvent(event);

  registry.register<{ events?: string[] }, { subscribed: string[] }>({
    name: 'events.subscribe',
    description:
      'Receive these events (all of them when events is omitted) as JSON-RPC notifications on this connection, whose method is the event name and params its payload. Replaces an earlier subscription.',
    params: {
      type: 'object',
      properties: { events: { type: 'array', items: { type: 'string', enum: EVENT_NAMES } } },
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: { subscribed: { type: 'array', items: { type: 'string' } } },
      required: ['subscribed'],
    },
    handler: ({ events }, context) => {
      if (!context.connection) {
        throw new AutomationError(
          'not_supported',
          'events need a connection that stays open (the socket or pipe); use export.wait instead',
          { code: ErrorCode.InvalidRequest },
        );
      }
      context.connection.subscribe(events ?? '*');
      return { subscribed: events ?? [...EVENT_NAMES] };
    },
  });

  registry.register<Record<string, never>, { subscribed: string[] }>({
    name: 'events.unsubscribe',
    description: 'Stop receiving events on this connection.',
    params: { type: 'object', additionalProperties: false },
    result: {
      type: 'object',
      properties: { subscribed: { type: 'array', items: { type: 'string' } } },
      required: ['subscribed'],
    },
    handler: (_params, context) => {
      context.connection?.unsubscribe();
      return { subscribed: [] };
    },
  });
}
