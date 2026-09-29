/** Exercise the CLI through a real local server so framing and cleanup are covered. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MethodRegistry } from '../registry.js';
import { AutomationServer } from '../server.js';
import type { Transport } from '../transport.js';
import { formatHuman } from './format.js';
import { type CliIo, runCli } from './run.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function io(_socket: string): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      env: {},
      platform: 'linux',
      username: 'test',
      tmpdir: os.tmpdir(),
      execPath: process.execPath,
      cliPath: '/cli.js',
      exists: () => false,
    },
    out,
    err,
  };
}

let pipeCount = 0;

/** Where a test server listens: a temp Unix socket, or on Windows a named pipe. */
function scratchSocketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\recso-cli-test-${process.pid}-${++pipeCount}`;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-cli-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'recso/api.sock');
}

async function server(socketPath = scratchSocketPath()) {
  const transport: Transport =
    process.platform === 'win32'
      ? { kind: 'pipe', path: socketPath }
      : { kind: 'unix', dir: path.dirname(socketPath), path: socketPath };
  const registry = new MethodRegistry();
  registry.register({
    name: 'app.status',
    description: 'status',
    params: { type: 'object' },
    result: {},
    handler: () => ({
      api: '1.0',
      app: '9.9',
      platform: 'linux',
      socket: transport.path,
      engine: { available: false, encoders: [] },
      recording: { state: 'idle' },
      editor: null,
    }),
  });
  registry.register({
    name: 'events.subscribe',
    description: 'subscribe',
    params: { type: 'object' },
    result: {},
    handler: (_params, context) => {
      context.connection?.subscribe('*');
      return {};
    },
  });
  const instance = new AutomationServer({ registry, transport });
  await instance.start();
  cleanups.push(() => instance.stop());
  return { instance, transport };
}

describe('runCli', () => {
  it('handles local help, version, usage, and absent MCP', async () => {
    const { io: target, out, err } = io('unused');
    expect(await runCli(['--help'], target)).toBe(0);
    expect(out.pop()).toContain('Usage: recso-cli');
    expect(await runCli(['--version'], target)).toBe(0);
    expect(out.pop()).toBe('recso-cli (API 1.0)\n');
    expect(await runCli(['--bad'], target)).toBe(2);
    expect(err.pop()).toContain('Run recso-cli --help for usage.');
    expect(await runCli(['mcp'], target)).toBe(1);
    expect(err.pop()).toContain('MCP server is not built');
  });

  it('prints useful offline and launch-failure diagnostics', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-cli-offline-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const { io: target, err } = io(path.join(root, 'missing.sock'));
    expect(await runCli(['status', '--socket', path.join(root, 'missing.sock')], target)).toBe(3);
    expect(err.pop()).toContain('Automation API is off');
    target.launch = () => false;
    expect(
      await runCli(['--launch', 'status', '--socket', path.join(root, 'missing.sock')], target),
    ).toBe(3);
    expect(err.pop()).toContain('Could not find recso');
  });

  it('launches recso and completes the command after its socket comes up', async () => {
    const socketPath = scratchSocketPath();
    const { io: target, out } = io(socketPath);
    let started!: Promise<unknown>;
    const launch = vi.fn(() => {
      started = new Promise((resolve, reject) => {
        setTimeout(() => server(socketPath).then(resolve, reject), 40);
      });
      return true;
    });
    target.launch = launch;

    const exitCode = await runCli(
      ['--launch', 'status', '--socket', socketPath, '--timeout', '2000'],
      target,
    );
    await started;
    expect(exitCode).toBe(0);
    expect(launch).toHaveBeenCalledOnce();
    expect(out.join('')).toContain('recso 9.9 (linux), API 1.0');
  });

  it('calls methods with human and JSON output and reports RPC errors', async () => {
    const { transport } = await server();
    const { io: target, out, err } = io(transport.path);
    expect(await runCli(['status', '--socket', transport.path], target)).toBe(0);
    expect(out.pop()).toContain('Recording: idle');
    expect(await runCli(['--json', 'status', '--socket', transport.path], target)).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject({ api: '1.0' });
    expect(await runCli(['call', 'missing', '--socket', transport.path], target)).toBe(1);
    expect(err.pop()).toContain('method_not_found');
    expect(await runCli(['--json', 'call', 'missing', '--socket', transport.path], target)).toBe(1);
    expect(JSON.parse(out.pop()!)).toMatchObject({ error: { reason: 'method_not_found' } });
  });

  it('streams notifications until interruption', async () => {
    const { instance, transport } = await server();
    const { io: target, out } = io(transport.path);
    let interrupt!: () => void;
    target.interrupted = new Promise<void>((resolve) => {
      interrupt = resolve;
    });
    const running = runCli(['events', '--socket', transport.path], target);
    for (let i = 0; i < 100 && instance.connectionCount === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    for (let i = 0; i < 100; i++) {
      instance.broadcast('recording.started', { recordingId: 'r1' });
      if (out.length) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(JSON.parse(out[0])).toEqual({ event: 'recording.started', data: { recordingId: 'r1' } });
    interrupt();
    expect(await running).toBe(0);
  });

  it('returns 3 if the event connection drops', async () => {
    const { instance, transport } = await server();
    const { io: target } = io(transport.path);
    const running = runCli(['events', '--socket', transport.path], target);
    for (let i = 0; i < 100 && instance.connectionCount === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    await instance.stop();
    expect(await running).toBe(3);
  });
});

describe('formatHuman', () => {
  it('formats known results and falls back for incomplete shapes', () => {
    expect(formatHuman('start', { videoPath: '/x' })).toBe('Recording → /x');
    expect(formatHuman('stop', { videoPath: '/x', durationMs: 1200, projectDir: '/p' })).toBe(
      'Saved /x (1.2 s)\nProject: /p',
    );
    expect(formatHuman('export', { output: '/x', state: 'finished' })).toBe('Exported /x');
    expect(
      formatHuman('describe', {
        methods: [{ name: 'a', description: 'First. Second' }],
        events: [{ name: 'e', description: 'Event. More' }],
      }),
    ).toBe('a  First.\n\nEvents:\ne  Event.');
    expect(formatHuman('start', {})).toBe('{}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatHuman('start', circular)).toBe('[unserializable result]');
  });
});
