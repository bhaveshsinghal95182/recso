import { describe, expect, it, vi } from 'vitest';

import type { JsonRpcResponse } from '../protocol.js';
import { MethodRegistry } from '../registry.js';
import type { AutomationServices } from '../services.js';
import { fakeServices } from '../testing.js';
import { registerRecordingMethods } from './recording.js';

function setup(overrides: Partial<AutomationServices> = {}) {
  const services = fakeServices(overrides);
  const registry = new MethodRegistry();
  registerRecordingMethods(registry, services);
  const call = async (method: string, params: unknown = {}) => {
    const response: JsonRpcResponse = await registry.call(1, method, params, {});
    return response;
  };
  return { services, call };
}

function reasonOf(response: JsonRpcResponse): string | undefined {
  return 'error' in response ? response.error.data?.reason : undefined;
}

describe('settings.get and settings.set', () => {
  it('reads all settings or the keys asked for', async () => {
    const { call } = setup();
    const all = await call('settings.get');
    expect('result' in all && all.result).toMatchObject({
      values: { 'recording.outputDir': '/home/me/Videos', 'export.preset': '1080p-high' },
    });
    const some = await call('settings.get', { keys: ['recording.mic'] });
    expect('result' in some && some.result).toEqual({ values: { 'recording.mic': false } });
  });

  it('changes settings and reports what changed', async () => {
    const { call, services } = setup();
    const response = await call('settings.set', {
      values: { 'recording.mic': true, 'recording.systemAudio': true },
    });
    expect('result' in response && response.result).toMatchObject({ changed: ['recording.mic'] });
    expect(services.settings.value('recording.mic')).toBe(true);
  });

  it('rejects unknown keys, wrong types and relative paths', async () => {
    const { call, services } = setup();
    expect(reasonOf(await call('settings.set', { values: { nope: 1 } }))).toBe('invalid_params');
    expect(reasonOf(await call('settings.set', { values: { 'recording.mic': 'yes' } }))).toBe(
      'invalid_params',
    );
    expect(
      reasonOf(await call('settings.set', { values: { 'recording.outputDir': 'Videos' } })),
    ).toBe('invalid_params');
    expect(reasonOf(await call('settings.set', { values: { 'export.preset': '8k-ultra' } }))).toBe(
      'invalid_params',
    );
    expect(services.settings.value('recording.outputDir')).toBe('/home/me/Videos');
  });

  it('checks paths the Windows way on Windows', async () => {
    const { call, services } = setup({ platform: 'win32' });
    expect(
      reasonOf(await call('settings.set', { values: { 'recording.outputDir': '/home/me' } })),
    ).toBe('invalid_params');
    await call('settings.set', { values: { 'export.outputDir': 'D:\\Media\\Footage' } });
    expect(services.settings.value('export.outputDir')).toBe('D:\\Media\\Footage');
  });
});

describe('recording.start', () => {
  it('passes the request on', async () => {
    const startRecording = vi.fn(async () => ({
      recordingId: 'r',
      sourceId: 's',
      videoPath: '/tmp/x/x.mp4',
    }));
    const { call } = setup({ startRecording });
    const response = await call('recording.start', {
      outputDir: '/tmp/x/../out',
      fileName: ' take-1 ',
      mic: true,
    });
    expect('result' in response).toBe(true);
    expect(startRecording).toHaveBeenCalledWith({
      outputDir: '/tmp/out',
      fileName: 'take-1',
      mic: true,
    });
  });

  it('refuses relative folders and names that are paths', async () => {
    const startRecording = vi.fn();
    const { call } = setup({ startRecording });
    expect(reasonOf(await call('recording.start', { outputDir: 'out' }))).toBe('invalid_params');
    for (const fileName of ['a/b', 'a\\b', 'a:b', '..', '', 'a?']) {
      expect(reasonOf(await call('recording.start', { fileName }))).toBe('invalid_params');
    }
    expect(reasonOf(await call('recording.start', { bogus: true }))).toBe('invalid_params');
    expect(startRecording).not.toHaveBeenCalled();
  });

  it('reports the service failure reason', async () => {
    const { AutomationError } = await import('../protocol.js');
    const { call } = setup({
      startRecording: async () => {
        throw new AutomationError('already_recording', 'recso is already recording');
      },
    });
    expect(reasonOf(await call('recording.start'))).toBe('already_recording');
  });
});

describe('the other recording methods', () => {
  it('stop returns the project', async () => {
    const { call } = setup();
    const response = await call('recording.stop');
    expect('result' in response && response.result).toMatchObject({
      projectDir: '/home/me/Videos/rec',
      cameraPath: null,
    });
  });

  it('pause and resume say why they fail', async () => {
    const idle = setup();
    expect(reasonOf(await idle.call('recording.pause'))).toBe('not_recording');
    const busy = setup({
      recordingState: () => ({
        state: 'recording',
        recordingId: 'r',
        durationMs: 10,
        bytesWritten: 1,
      }),
    });
    expect(reasonOf(await busy.call('recording.resume'))).toBe('not_supported');
  });

  it('devices.list, recording.state and sources.forget answer', async () => {
    const { call } = setup({ forgetSource: () => true });
    const devices = await call('devices.list');
    expect('result' in devices && devices.result).toMatchObject({ rememberedSource: false });
    const state = await call('recording.state');
    expect('result' in state && state.result).toMatchObject({ state: 'idle' });
    const forgotten = await call('sources.forget');
    expect('result' in forgotten && forgotten.result).toEqual({ forgotten: true });
  });
});
