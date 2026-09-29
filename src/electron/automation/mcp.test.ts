import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { AutomationCallError } from './client.js';
import {
  LAUNCH_TOOL,
  type McpClient,
  type McpServerOptions,
  runMcpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  toolName,
  toolsFromDescribe,
} from './mcp.js';
import { type MethodDescription, MethodRegistry } from './registry.js';
import { AutomationServer } from './server.js';
import type { Transport } from './transport.js';

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const echo: MethodDescription = {
  name: 'demo.echo',
  description: 'echo',
  params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  result: { type: 'object' },
};

function fakeClient(
  call?: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): McpClient {
  return {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      const result = call
        ? await call(method, params)
        : method === 'api.describe'
          ? { methods: [echo] }
          : { text: params?.text };
      return result as T;
    },
    close: () => undefined,
    closedPromise: () => new Promise(() => undefined),
  };
}

function session(options: McpServerOptions = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Array<Record<string, any>> = [];
  const waiters: Array<() => void> = [];
  let partial = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    partial += chunk;
    const parts = partial.split('\n');
    partial = parts.pop() ?? '';
    for (const part of parts) {
      lines.push(JSON.parse(part));
      for (const notify of waiters.splice(0)) notify();
    }
  });
  const done = runMcpServer('/unused', { input, output, ...options });
  cleanups.push(async () => {
    input.end();
    expect(await done).toBe(0);
  });
  const send = (method: string, id: number, params?: unknown) => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  };
  const until = async (count: number) => {
    while (lines.length < count) await new Promise<void>((resolve) => waiters.push(resolve));
    return lines;
  };
  return { input, lines, send, until };
}

describe('MCP mapping', () => {
  it('converts dotted method names and rejects invalid names', () => {
    expect(toolName('recording.start')).toBe('recording_start');
    expect(toolName('api.describe')).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(() => toolName('bad name')).toThrow();
    expect(() => toolName('a'.repeat(65))).toThrow();
  });

  it('filters subscriptions, appends ordered notes and repairs parameter schemas', () => {
    const methods: MethodDescription[] = [
      {
        ...echo,
        platforms: { darwin: 'C', linux: 'A', win32: 'B' },
        params: { type: ['object', 'null'] },
      },
      { ...echo, name: 'demo.empty', params: {} },
      { ...echo, name: 'demo.string', params: { type: 'string' } },
      { ...echo, name: 'events.subscribe' },
      { ...echo, name: 'events.unsubscribe' },
    ];
    const tools = toolsFromDescribe(methods);
    expect(tools.map((tool) => tool.name)).toEqual(['demo_echo', 'demo_empty', 'demo_string']);
    expect(tools[0].description).toBe('echo\n\nOn Linux: A\n\nOn Windows: B\n\nOn macOS: C');
    expect(tools[0].inputSchema).toEqual({ type: 'object', properties: {} });
    expect(tools[1].inputSchema).toEqual({ type: 'object', properties: {} });
    expect(tools[2].inputSchema).toEqual({ type: 'object', properties: {} });
  });
});

describe('MCP session', () => {
  it('negotiates versions, pings, ignores notifications and reports bad requests', async () => {
    const s = session();
    s.send('initialize', 1, { protocolVersion: '2024-11-05' });
    s.send('initialize', 2, { protocolVersion: 'unsupported' });
    s.send('initialize', 3);
    s.send('ping', 4);
    s.input.write('{bad json\n');
    s.send('unknown', 5);
    s.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    s.input.write('{"jsonrpc":"2.0","method":"ping"}\n');
    await s.until(6);
    expect(s.lines.find((line) => line.id === 1)?.result.protocolVersion).toBe('2024-11-05');
    expect(s.lines.find((line) => line.id === 2)?.result.protocolVersion).toBe(
      SUPPORTED_PROTOCOL_VERSIONS[0],
    );
    expect(s.lines.find((line) => line.id === 3)?.result.protocolVersion).toBe(
      SUPPORTED_PROTOCOL_VERSIONS[0],
    );
    expect(s.lines.find((line) => line.id === 4)?.result).toEqual({});
    expect(s.lines.find((line) => line.id === null)?.error).toEqual({
      code: -32700,
      message: 'Parse error',
    });
    expect(s.lines.find((line) => line.id === 5)?.error).toEqual({
      code: -32601,
      message: 'Method not found',
    });
    expect(s.lines).toHaveLength(6);
  });

  it('lists reachable tools and returns structured content', async () => {
    const connect = async () => fakeClient();
    const s = session({ connect });
    s.send('tools/list', 1);
    await s.until(1);
    expect(s.lines[0].result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'demo_echo',
      'recso_launch',
    ]);
    s.send('tools/call', 2, { name: 'demo_echo', arguments: { text: 'hi' } });
    await s.until(2);
    expect(s.lines[1].result.structuredContent).toEqual({ text: 'hi' });
    expect(s.lines[1].result.content).toEqual([{ type: 'text', text: '{\n  "text": "hi"\n}' }]);
  });

  it('lists only launch when unreachable and launch is available', async () => {
    const s = session({
      connect: async () => {
        throw new Error('offline');
      },
      launch: () => true,
    });
    s.send('tools/list', 1);
    await s.until(1);
    expect(s.lines[0].result.tools).toEqual([LAUNCH_TOOL]);
  });

  it('lists no tools when unreachable and launch is unavailable', async () => {
    const s = session({
      connect: async () => {
        throw new Error('offline');
      },
    });
    s.send('tools/list', 1);
    await s.until(1);
    expect(s.lines[0].result.tools).toEqual([]);
  });

  it('turns automation errors and connection failures into tool errors', async () => {
    const client = fakeClient(async (method) => {
      if (method === 'api.describe') return { methods: [echo] };
      throw new AutomationCallError('bad input', 'invalid_params', -32602, { field: 'text' });
    });
    const s = session({ connect: async () => client });
    s.send('tools/call', 1, { name: 'demo_echo' });
    await s.until(1);
    expect(s.lines[0].result).toMatchObject({ isError: true });
    expect(s.lines[0].result.content[0].text).toContain('invalid_params: bad input');
    const offline = session({
      connect: async () => {
        throw new Error('offline');
      },
    });
    offline.send('tools/call', 1, { name: 'demo_echo' });
    await offline.until(1);
    expect(offline.lines[0].result).toMatchObject({ isError: true });
  });

  it('launches after a short list and announces new tools', async () => {
    let launched = false;
    const s = session({
      connect: async () => {
        if (!launched) throw new Error('offline');
        return fakeClient();
      },
      launch: () => (launched = true),
    });
    s.send('tools/list', 1);
    await s.until(1);
    s.send('tools/call', 2, { name: 'recso_launch' });
    await s.until(3);
    expect(s.lines[1].result.content[0].text).toBe('recso is running');
    expect(s.lines[2]).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  });

  it('reports an unavailable executable', async () => {
    const s = session({
      connect: async () => {
        throw new Error('offline');
      },
      launch: () => false,
    });
    s.send('tools/call', 1, { name: 'recso_launch' });
    await s.until(1);
    expect(s.lines[0].result).toMatchObject({ isError: true });
    expect(s.lines[0].result.content[0].text).toContain('Could not find recso');
  });

  it('answers ping before a slow tool call completes', async () => {
    let release!: (value: unknown) => void;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const s = session({
      connect: async () =>
        fakeClient(async (method) => (method === 'api.describe' ? { methods: [echo] } : slow)),
    });
    s.send('tools/list', 1);
    await s.until(1);
    s.send('tools/call', 2, { name: 'demo_echo' });
    s.send('ping', 3);
    await s.until(2);
    expect(s.lines[1].id).toBe(3);
    release({ text: 'late' });
    await s.until(3);
    expect(s.lines[2].id).toBe(2);
  });
});

it.skipIf(process.platform === 'win32')('works against a real AutomationServer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-mcp-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'recso');
  const transport: Transport = { kind: 'unix', dir, path: path.join(dir, 'api.sock') };
  const registry = new MethodRegistry();
  registry.register({
    ...echo,
    params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: (params: { text: string }) => ({ text: params.text }),
  });
  registry.register({
    name: 'api.describe',
    description: 'describe',
    params: { type: 'object' },
    result: { type: 'object' },
    handler: () => ({ methods: registry.describeMethods() }),
  });
  const server = new AutomationServer({ registry, transport });
  await server.start();
  cleanups.push(() => server.stop());
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = '';
  const lines: Array<Record<string, any>> = [];
  const waiters: Array<() => void> = [];
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      lines.push(JSON.parse(part));
      for (const resolve of waiters.splice(0)) resolve();
    }
  });
  const done = runMcpServer(transport.path, { input, output });
  cleanups.push(async () => {
    input.end();
    await done;
  });
  const wait = async (count: number) => {
    while (lines.length < count) await new Promise<void>((resolve) => waiters.push(resolve));
  };
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  await wait(1);
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await wait(2);
  expect(lines[1].result.tools.some((tool: { name: string }) => tool.name === 'demo_echo')).toBe(
    true,
  );
  input.write(
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"demo_echo","arguments":{"text":"hi"}}}\n',
  );
  await wait(3);
  expect(lines[2].result.structuredContent).toEqual({ text: 'hi' });
  expect(lines[2].result.content[0].text).toContain('hi');
});
