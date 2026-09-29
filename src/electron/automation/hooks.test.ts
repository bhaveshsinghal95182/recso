import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { HookChild, HookCommand, HooksConfig } from './hooks.js';
import {
  cachedHooksLoader,
  hookEnv,
  HookRunner,
  HOOKS_FILE,
  hookSpawnPlan,
  parseHooksConfig,
  readHooksConfig,
  spawnHook,
} from './hooks.js';

const knownEvents = ['recording.stopped', 'export.finished'];

class FakeChild extends EventEmitter implements HookChild {
  stdin = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn((_signal?: NodeJS.Signals) => true);

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

function harness(
  commands: HookCommand[],
  options: { maxConcurrent?: number; timeoutMs?: number } = {},
) {
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const log = vi.fn();
  const runner = new HookRunner({
    platform: 'linux',
    loadHooks: () => ({ 'recording.stopped': commands }),
    spawn,
    log,
    env: {},
    ...options,
  });
  return { runner, children, spawn, log };
}

describe('parseHooksConfig', () => {
  it('parses valid hooks', () => {
    expect(
      parseHooksConfig(
        JSON.stringify({
          hooks: {
            'recording.stopped': [
              ['node', 'one'],
              ['echo', 'two'],
            ],
          },
        }),
        knownEvents,
      ),
    ).toEqual({
      hooks: {
        'recording.stopped': [
          ['node', 'one'],
          ['echo', 'two'],
        ],
      },
      errors: [],
    });
  });

  it('returns a parse error and empty hooks for invalid JSON', () => {
    const result = parseHooksConfig('{', knownEvents);
    expect(result.hooks).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^automation\.json is not valid JSON: /);
  });

  it('drops unknown events while keeping known siblings', () => {
    const result = parseHooksConfig(
      JSON.stringify({ hooks: { unknown: 'bad', 'export.finished': [['echo', 'done']] } }),
      knownEvents,
    );
    expect(result).toEqual({
      hooks: { 'export.finished': [['echo', 'done']] },
      errors: ['unknown event "unknown"'],
    });
  });

  it('skips bad commands and keeps good commands in order', () => {
    const result = parseHooksConfig(
      JSON.stringify({
        hooks: { 'recording.stopped': ['bad', [], ['echo', 3], ['', 'arg'], ['one'], ['two']] },
      }),
      knownEvents,
    );
    expect(result.hooks).toEqual({ 'recording.stopped': [['one'], ['two']] });
    expect(result.errors).toEqual(
      [0, 1, 2, 3].map(
        (index) =>
          `automation.json hooks["recording.stopped"][${index}] must be a non-empty array of strings`,
      ),
    );
  });

  it('accepts a config without hooks', () => {
    expect(parseHooksConfig('{"other":true}', knownEvents)).toEqual({ hooks: {}, errors: [] });
  });

  it('rejects invalid top-level and hooks shapes', () => {
    expect(parseHooksConfig('[]', knownEvents).errors).toEqual([
      'automation.json must be a JSON object',
    ]);
    expect(parseHooksConfig('{"hooks":[]}', knownEvents).errors).toEqual([
      'automation.json "hooks" must be an object',
    ]);
  });
});

describe('readHooksConfig and cachedHooksLoader', () => {
  it('treats a missing file as empty and reads a written file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-hooks-'));
    try {
      expect(readHooksConfig(dir, knownEvents)).toEqual({ hooks: {}, errors: [] });
      fs.writeFileSync(path.join(dir, HOOKS_FILE), '{"hooks":{"export.finished":[["echo","ok"]]}}');
      expect(readHooksConfig(dir, knownEvents)).toEqual({
        hooks: { 'export.finished': [['echo', 'ok']] },
        errors: [],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caches unchanged files and reloads when their size changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-hooks-'));
    try {
      const file = path.join(dir, HOOKS_FILE);
      fs.writeFileSync(file, '{"hooks":{"unknown":[["bad"]],"recording.stopped":[["one"]]}}');
      const onErrors = vi.fn();
      const load = cachedHooksLoader(dir, knownEvents, onErrors);
      const first = load();
      expect(first).toEqual({ 'recording.stopped': [['one']] });
      expect(load()).toBe(first);
      expect(onErrors).toHaveBeenCalledTimes(1);
      fs.writeFileSync(file, '{"hooks":{"export.finished":[["a","longer argument"]]}}');
      expect(load()).toEqual({ 'export.finished': [['a', 'longer argument']] });
      expect(onErrors).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hookEnv', () => {
  it('sets event, project directory, and export output', () => {
    expect(
      hookEnv('export.finished', { projectDir: '/project', output: '/video.mp4' }, {}),
    ).toEqual({
      RECSO_EVENT: 'export.finished',
      RECSO_PROJECT_DIR: '/project',
      RECSO_OUTPUT: '/video.mp4',
    });
  });

  it('uses the recording video path', () => {
    expect(hookEnv('recording.stopped', { videoPath: '/recording.mp4' }, {})).toEqual({
      RECSO_EVENT: 'recording.stopped',
      RECSO_OUTPUT: '/recording.mp4',
    });
  });

  it('removes stale hook values when the payload lacks them', () => {
    expect(
      hookEnv('recording.stopped', undefined, {
        RECSO_PROJECT_DIR: '/stale',
        RECSO_OUTPUT: '/stale.mp4',
        KEEP: 'yes',
      }),
    ).toEqual({ RECSO_EVENT: 'recording.stopped', KEEP: 'yes' });
  });
});

describe('hookSpawnPlan', () => {
  it('passes Linux commands and Windows executables through', () => {
    const expected = { file: '/bin/echo', args: ['a b'], windowsVerbatimArguments: false };
    expect(hookSpawnPlan('linux', ['/bin/echo', 'a b'], {})).toEqual(expected);
    expect(hookSpawnPlan('win32', ['tool.EXE', 'a b'], {})).toEqual({
      file: 'tool.EXE',
      args: ['a b'],
      windowsVerbatimArguments: false,
    });
  });

  it.each(['cmd', 'bat'])('quotes a Windows .%s command through ComSpec', (extension) => {
    const command = [`C:\\x\\h.${extension}`, 'a b', 'x&y'];
    expect(hookSpawnPlan('win32', command, { ComSpec: 'C:\\Windows\\cmd.exe' })).toEqual({
      file: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/s', '/c', `""C:\\x\\h.${extension}" "a b" "x&y""`],
      windowsVerbatimArguments: true,
    });
  });

  it('falls back to cmd.exe without ComSpec', () => {
    expect(hookSpawnPlan('win32', ['h.cmd'], {}).file).toBe('cmd.exe');
  });

  it('rejects quotes and percent signs in batch arguments', () => {
    expect(() => hookSpawnPlan('win32', ['h.cmd', 'a"b'], {})).toThrow(/a\\"b/);
    expect(() => hookSpawnPlan('win32', ['h.bat', '%PATH%'], {})).toThrow(/%PATH%/);
  });
});

describe('HookRunner', () => {
  it('writes event JSON to stdin and finishes silently on zero exit', () => {
    const h = harness([['echo']]);
    const payload = { videoPath: '/video.mp4' };
    h.runner.run('recording.stopped', payload);
    expect(h.runner.running()).toBe(1);
    const input = h.children[0].stdin;
    expect(input.read()?.toString()).toBe(
      `${JSON.stringify({ event: 'recording.stopped', data: payload })}\n`,
    );
    h.children[0].exit(0);
    expect(h.runner.running()).toBe(0);
    expect(h.log).not.toHaveBeenCalled();
  });

  it('logs a nonzero exit with the stderr tail', () => {
    const h = harness([['echo']]);
    h.runner.run('recording.stopped', {});
    h.children[0].stderr.write(`old${'x'.repeat(2100)}\nlast failure\n`);
    h.children[0].exit(2);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('exited with 2:'));
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('last failure'));
    expect(h.runner.running()).toBe(0);
  });

  it('logs a child start error once even if exit follows', () => {
    const h = harness([['echo']]);
    h.runner.run('recording.stopped', {});
    h.children[0].emit('error', new Error('missing executable'));
    h.children[0].exit(1);
    expect(h.log).toHaveBeenCalledOnce();
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining('failed to start: missing executable'),
    );
    expect(h.runner.running()).toBe(0);
  });

  it('terminates a timed-out child and escalates after five seconds', async () => {
    vi.useFakeTimers();
    try {
      const h = harness([['slow']], { timeoutMs: 2000 });
      h.runner.run('recording.stopped', {});
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.children[0].kill).toHaveBeenCalledWith('SIGTERM');
      expect(h.log).toHaveBeenCalledWith('hook slow for recording.stopped killed after 2s');
      expect(h.runner.running()).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.children[0].kill).toHaveBeenCalledWith('SIGKILL');
      h.children[0].exit(null, 'SIGKILL');
      expect(h.runner.running()).toBe(0);
      expect(h.log).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips each excess command at the concurrency limit', () => {
    const h = harness([['one'], ['two'], ['three']], { maxConcurrent: 1 });
    h.runner.run('recording.stopped', {});
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.runner.running()).toBe(1);
    expect(h.log).toHaveBeenCalledTimes(2);
    h.children[0].exit(0);
    expect(h.runner.running()).toBe(0);
  });

  it('stops every running child', () => {
    const h = harness([['one'], ['two']]);
    h.runner.run('recording.stopped', {});
    expect(h.runner.running()).toBe(2);
    h.runner.stopAll();
    expect(h.children.every((child) => child.kill.mock.calls[0]?.[0] === 'SIGTERM')).toBe(true);
    h.children[0].exit(0);
    h.children[1].exit(0);
    expect(h.runner.running()).toBe(0);
  });

  it('logs an unsafe batch command without spawning it', () => {
    const spawn = vi.fn();
    const log = vi.fn();
    const runner = new HookRunner({
      platform: 'win32',
      loadHooks: () => ({ 'recording.stopped': [['h.cmd', 'a"b']] }),
      spawn,
      log,
    });
    runner.run('recording.stopped', {});
    expect(spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not run:'));
    expect(runner.running()).toBe(0);
  });

  it('handles loader and synchronous spawn failures', () => {
    const log = vi.fn();
    const loadHooks = vi.fn<() => HooksConfig>(() => {
      throw new Error('bad file');
    });
    const spawn = vi.fn(() => {
      throw new Error('cannot spawn');
    });
    const runner = new HookRunner({ platform: 'linux', loadHooks, spawn, log });
    runner.run('recording.stopped', {});
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bad file'));
    loadHooks.mockReturnValue({ 'recording.stopped': [['echo']] });
    runner.run('recording.stopped', {});
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not run: cannot spawn'));
    expect(runner.running()).toBe(0);
  });
});

it.skipIf(process.platform === 'win32')('runs a real hook with stdin and environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-hook-process-'));
  try {
    const output = path.join(dir, 'received.txt');
    const event = 'recording.stopped';
    const payload = { videoPath: '/video.mp4' };
    const command = [
      process.execPath,
      '-e',
      "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8') + process.env.RECSO_EVENT)",
      output,
    ];
    const log = vi.fn();
    const runner = new HookRunner({
      platform: process.platform,
      loadHooks: () => ({ [event]: [command] }),
      spawn: spawnHook,
      log,
      env: process.env,
    });
    runner.run(event, payload);
    const deadline = Date.now() + 5000;
    while (runner.running() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runner.running()).toBe(0);
    expect(log).not.toHaveBeenCalled();
    expect(fs.readFileSync(output, 'utf8')).toBe(
      `${JSON.stringify({ event, data: payload })}\n${event}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
