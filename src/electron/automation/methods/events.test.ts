import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { projectEvents, recorderEvents } from '../../services/recorder-events.js';
import type { RecordingConfig } from '../../types/recorder.types.js';
import { connectEvents } from '../event-bridge.js';
import { MethodRegistry } from '../registry.js';
import { defaultSettings, SettingsStore } from '../settings-store.js';
import {
  EVENT_NAMES,
  recordingStartedPayload,
  recordingStoppedPayload,
  registerEventMethods,
} from './events.js';

const config = {
  sourceId: 'screen:portal',
  outputDir: '/home/me/Videos',
  fileName: 'take',
  fileExtension: 'mp4',
} as RecordingConfig;

describe('event payloads', () => {
  it('describes a started recording', () => {
    expect(recordingStartedPayload({ recordingId: 'r', config })).toEqual({
      recordingId: 'r',
      sourceId: 'screen:portal',
      // The recorder's own paths: the host's separator.
      videoPath: path.join('/home/me/Videos', 'take', 'take.mp4'),
    });
  });

  it('describes a stopped recording and a failed one', () => {
    expect(
      recordingStoppedPayload({
        recordingId: 'r',
        clicks: 2,
        result: {
          success: true,
          filePath: '/home/me/Videos/take/take.mp4',
          media: { durationMs: 5000 } as never,
        },
      }),
    ).toEqual({
      recordingId: 'r',
      success: true,
      projectDir: '/home/me/Videos/take',
      videoPath: '/home/me/Videos/take/take.mp4',
      durationMs: 5000,
      clicks: 2,
      error: null,
    });
    expect(
      recordingStoppedPayload({
        recordingId: 'r',
        clicks: 0,
        result: { success: false, error: 'x' },
      }),
    ).toMatchObject({ success: false, projectDir: null, videoPath: null, error: 'x' });
  });
});

describe('events.subscribe', () => {
  function setup() {
    const registry = new MethodRegistry();
    registerEventMethods(registry);
    const connection = { id: 1, subscribe: vi.fn(), unsubscribe: vi.fn() };
    return { registry, connection };
  }

  it('registers every event', () => {
    const { registry } = setup();
    expect(registry.eventNames()).toEqual(EVENT_NAMES);
    expect(EVENT_NAMES).toContain('recording.stopped');
    expect(EVENT_NAMES).toContain('export.finished');
  });

  it('subscribes the connection to some or all events', async () => {
    const { registry, connection } = setup();
    const some = await registry.call(
      1,
      'events.subscribe',
      { events: ['recording.stopped'] },
      {
        connection,
      },
    );
    expect('result' in some && some.result).toEqual({ subscribed: ['recording.stopped'] });
    expect(connection.subscribe).toHaveBeenCalledWith(['recording.stopped']);
    await registry.call(2, 'events.subscribe', {}, { connection });
    expect(connection.subscribe).toHaveBeenLastCalledWith('*');
    await registry.call(3, 'events.unsubscribe', {}, { connection });
    expect(connection.unsubscribe).toHaveBeenCalled();
  });

  it('refuses unknown events and connectionless callers', async () => {
    const { registry, connection } = setup();
    const unknown = await registry.call(
      1,
      'events.subscribe',
      { events: ['nope'] },
      { connection },
    );
    expect('error' in unknown && unknown.error.data?.reason).toBe('invalid_params');
    const none = await registry.call(2, 'events.subscribe', {}, {});
    expect('error' in none && none.error.data?.reason).toBe('not_supported');
  });
});

describe('connectEvents', () => {
  it('turns recso events into API events until disconnected', () => {
    const sink = vi.fn();
    const settings = new SettingsStore(defaultSettings('/home/me/Videos'));
    const disconnect = connectEvents(sink, settings);

    recorderEvents.emit('started', { recordingId: 'r', config });
    recorderEvents.emit('stopping', { recordingId: 'r' });
    recorderEvents.emit('stopped', {
      recordingId: 'r',
      clicks: 1,
      result: { success: true, filePath: '/home/me/Videos/take/take.mp4' },
    });
    projectEvents.emit('saved', {
      projectDir: '/home/me/Videos/take',
      name: 'take',
      recordingId: 'r',
    });
    settings.set({ 'recording.mic': true });

    expect(sink.mock.calls.map(([event]) => event)).toEqual([
      'recording.started',
      'recording.stateChanged',
      'recording.stateChanged',
      'recording.stateChanged',
      'recording.stopped',
      'project.saved',
      'settings.changed',
    ]);
    expect(sink.mock.calls[6][1]).toMatchObject({ changed: ['recording.mic'] });

    disconnect();
    sink.mockClear();
    recorderEvents.emit('stopping', { recordingId: 'r' });
    settings.set({ 'recording.mic': false });
    expect(sink).not.toHaveBeenCalled();
    expect(recorderEvents.listenerCount('started')).toBe(0);
  });
});
