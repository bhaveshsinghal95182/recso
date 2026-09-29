import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { registerCoreMethods } from './methods/core.js';
import { AutomationClient } from './client.js';
import { automationEnabled, readStoredEnabled, writeStoredEnabled } from './enabled.js';
import { MethodRegistry } from './registry.js';
import { AutomationServer } from './server.js';
import { fakeServices } from './testing.js';
import type { Transport } from './transport.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let pipeCount = 0;

/** A Unix socket in a temp directory, or on Windows a named pipe of its own. */
function scratchTransport(): Transport {
  if (process.platform === 'win32') {
    return { kind: 'pipe', path: `\\\\.\\pipe\\recso-test-${process.pid}-${++pipeCount}` };
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-server-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'recso');
  return { kind: 'unix', dir, path: path.join(dir, 'api.sock') };
}

async function startServer(onCount?: (count: number) => void) {
  const registry = new MethodRegistry();
  registerCoreMethods(registry, fakeServices());
  registry.register({
    name: 'test.subscribe',
    description: 'subscribe this connection to everything',
    params: { type: 'object' },
    result: {},
    handler: (_params, context) => {
      context.connection?.subscribe('*');
      return { subscribed: true };
    },
  });
  const transport = scratchTransport();
  const server = new AutomationServer({ registry, transport, onConnectionCountChange: onCount });
  await server.start();
  cleanups.push(() => server.stop());
  return { server, transport };
}

/** Write raw bytes and collect the lines that come back. */
function rawExchange(
  socketPath: string,
  chunks: string[],
  expectedLines: number,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      buffer += data;
      const lines = buffer.split('\n').filter(Boolean);
      if (lines.length >= expectedLines) {
        socket.destroy();
        resolve(lines.map((line) => JSON.parse(line)));
      }
    });
    socket.on('error', reject);
    socket.on('connect', async () => {
      for (const chunk of chunks) {
        socket.write(chunk);
        await new Promise((r) => setTimeout(r, 10));
      }
    });
  });
}

describe('AutomationServer', () => {
  // A pipe has no mode bits; its ACL is libuv's default (see the Log).
  it.skipIf(process.platform === 'win32')('makes the socket private to the user', async () => {
    const { transport } = await startServer();
    expect(fs.statSync(transport.path).mode & 0o777).toBe(0o600);
    if (transport.kind === 'unix') expect(fs.statSync(transport.dir).mode & 0o777).toBe(0o700);
  });

  it('answers a request split across writes, and several in one write', async () => {
    const { transport } = await startServer();
    const responses = await rawExchange(
      transport.path,
      [
        '{"jsonrpc":"2.0","id":1,"meth',
        'od":"api.version"}\n{"jsonrpc":"2.0","id":2,"method":"api.version"}\n{"jsonrpc":"2.0","id":3,',
        '"method":"app.status"}\n',
      ],
      3,
    );
    expect(responses.map((response) => (response as { id: number }).id).sort()).toEqual([1, 2, 3]);
  });

  it('answers bad JSON with a parse error and keeps the connection', async () => {
    const { transport } = await startServer();
    const responses = await rawExchange(
      transport.path,
      ['{not json\n', '{"jsonrpc":"2.0","id":9,"method":"api.version"}\n'],
      2,
    );
    expect(responses[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(responses[1]).toMatchObject({ id: 9, result: { api: '1.0' } });
  });

  it('does not answer notifications', async () => {
    const { transport } = await startServer();
    const responses = await rawExchange(
      transport.path,
      [
        '{"jsonrpc":"2.0","method":"api.version"}\n{"jsonrpc":"2.0","id":"a","method":"api.version"}\n',
      ],
      1,
    );
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'a', result: { api: '1.0', app: '9.9.9' } }]);
  });

  it('works through the client, and sends events only to subscribers', async () => {
    const { server, transport } = await startServer();
    const subscriber = await AutomationClient.connect(transport.path);
    const bystander = await AutomationClient.connect(transport.path);
    cleanups.push(
      () => subscriber.close(),
      () => bystander.close(),
    );

    const heard: unknown[] = [];
    const ignored: unknown[] = [];
    subscriber.onNotification((message) => heard.push(message));
    bystander.onNotification((message) => ignored.push(message));

    await subscriber.call('test.subscribe');
    await bystander.call('api.version');
    server.broadcast('recording.started', { recordingId: 'r1' });
    await subscriber.call('api.version');

    expect(heard).toEqual([
      { jsonrpc: '2.0', method: 'recording.started', params: { recordingId: 'r1' } },
    ]);
    expect(ignored).toEqual([]);
  });

  it('reports method errors to the client with their reason', async () => {
    const { transport } = await startServer();
    const client = await AutomationClient.connect(transport.path);
    cleanups.push(() => client.close());
    await expect(client.call('nope')).rejects.toMatchObject({ reason: 'method_not_found' });
  });

  it('counts connections for the "API connected" hint', async () => {
    const counts: number[] = [];
    const { transport } = await startServer((count) => counts.push(count));
    const client = await AutomationClient.connect(transport.path);
    await client.call('api.version');
    client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(counts).toEqual([1, 0]);
  });

  it('closes its clients and removes the socket when stopped', async () => {
    const { server, transport } = await startServer();
    const client = await AutomationClient.connect(transport.path);
    const closed = client.closedPromise();
    await server.stop();
    await closed;
    if (transport.kind === 'unix') expect(fs.existsSync(transport.path)).toBe(false);
    await expect(AutomationClient.connect(transport.path)).rejects.toMatchObject({
      reason: 'not_running',
    });
  });

  it('refuses to share a live socket or pipe', async () => {
    const { transport } = await startServer();
    const second = new AutomationServer({ registry: new MethodRegistry(), transport });
    await expect(second.start()).rejects.toThrow(/already serving/);
  });

  it('creates nothing until started', () => {
    const transport = scratchTransport();
    new AutomationServer({ registry: new MethodRegistry(), transport });
    if (transport.kind === 'unix') expect(fs.existsSync(transport.dir)).toBe(false);
  });

  it('a client gets not_running when nothing listens', async () => {
    const transport = scratchTransport();
    await expect(AutomationClient.connect(transport.path)).rejects.toMatchObject({
      reason: 'not_running',
    });
  });
});

describe('turning the API on', () => {
  it('is off by default', () => {
    expect(automationEnabled({}, false)).toBe(false);
  });

  it('follows the stored setting, and RECSO_AUTOMATION overrides it both ways', () => {
    expect(automationEnabled({}, true)).toBe(true);
    expect(automationEnabled({ RECSO_AUTOMATION: '1' }, false)).toBe(true);
    expect(automationEnabled({ RECSO_AUTOMATION: '0' }, true)).toBe(false);
    expect(automationEnabled({ RECSO_AUTOMATION: '' }, false)).toBe(false);
  });

  it('stores the toggle, and reads a missing or broken file as off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-enabled-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    expect(readStoredEnabled(dir)).toBe(false);
    writeStoredEnabled(dir, true);
    expect(readStoredEnabled(dir)).toBe(true);
    fs.writeFileSync(path.join(dir, 'automation-settings.json'), '{oops');
    expect(readStoredEnabled(dir)).toBe(false);
  });
});
