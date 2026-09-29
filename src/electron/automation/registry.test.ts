import { describe, expect, it, vi } from 'vitest';

import { registerCoreMethods } from './methods/core.js';
import { AutomationError, ErrorCode } from './protocol.js';
import { API_VERSION, MethodRegistry } from './registry.js';
import { fakeServices } from './testing.js';

function registryWith(overrides = {}) {
  const registry = new MethodRegistry();
  registerCoreMethods(registry, fakeServices(overrides));
  return registry;
}

describe('MethodRegistry', () => {
  it('answers api.version', async () => {
    expect(await registryWith().call(1, 'api.version', {})).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { api: API_VERSION, app: '9.9.9' },
    });
  });

  it('treats missing params as an empty object', async () => {
    const response = await registryWith().call(2, 'api.version', undefined);
    expect('result' in response).toBe(true);
  });

  it('describes every registered method with its schemas', async () => {
    const response = await registryWith().call(3, 'api.describe', {});
    if (!('result' in response)) throw new Error('expected a result');
    const result = response.result as { methods: Array<{ name: string; params: unknown }> };
    expect(result.methods.map((method) => method.name)).toEqual([
      'api.version',
      'api.describe',
      'app.status',
      'app.show',
    ]);
    expect(result.methods[0].params).toEqual({ type: 'object', additionalProperties: false });
  });

  it('reports unknown methods with a stable reason', async () => {
    const response = await registryWith().call(4, 'nope.nothing', {});
    expect(response).toMatchObject({
      id: 4,
      error: { code: ErrorCode.MethodNotFound, data: { reason: 'method_not_found' } },
    });
  });

  it('rejects params the schema does not allow', async () => {
    const response = await registryWith().call(5, 'api.version', { extra: true });
    expect(response).toMatchObject({
      error: { code: ErrorCode.InvalidParams, data: { reason: 'invalid_params' } },
    });
  });

  it('rejects by-position params', async () => {
    const response = await registryWith().call(6, 'api.version', []);
    expect(response).toMatchObject({ error: { data: { reason: 'invalid_params' } } });
  });

  it("turns a handler's AutomationError into its reason and code", async () => {
    const registry = new MethodRegistry().register({
      name: 'x.fail',
      description: 'fails',
      params: { type: 'object' },
      result: {},
      handler: () => {
        throw new AutomationError('not_recording', 'nothing is recording');
      },
    });
    expect(await registry.call(7, 'x.fail', {})).toMatchObject({
      error: {
        code: ErrorCode.AppError,
        message: 'nothing is recording',
        data: { reason: 'not_recording' },
      },
    });
  });

  it('refuses to register a method twice', () => {
    expect(() =>
      registryWith().register({
        name: 'api.version',
        description: '',
        params: { type: 'object' },
        result: {},
        handler: () => null,
      }),
    ).toThrow(/twice/);
  });
});

describe('core methods', () => {
  it('app.status reports the engine, encoders, recording and editor', async () => {
    const response = await registryWith({
      editorProject: () => ({ projectDir: '/v/take', name: 'take' }),
    }).call(1, 'app.status', {});
    expect(response).toMatchObject({
      result: {
        api: API_VERSION,
        app: '9.9.9',
        platform: 'linux',
        engine: { available: true, encoders: ['nvenc', 'openh264'] },
        recording: { state: 'idle', recordingId: null },
        editor: { projectDir: '/v/take', name: 'take' },
      },
    });
  });

  it('app.status lists no encoders without an engine', async () => {
    const response = await registryWith({ engineAvailable: () => false }).call(1, 'app.status', {});
    expect(response).toMatchObject({ result: { engine: { available: false, encoders: [] } } });
  });

  it('app.show brings the window forward', async () => {
    const showWindow = vi.fn();
    await registryWith({ showWindow }).call(1, 'app.show', {});
    expect(showWindow).toHaveBeenCalledOnce();
  });
});
