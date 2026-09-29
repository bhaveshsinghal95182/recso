/** Cover the public spelling of commands before they reach the socket. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCliArgs, UsageError } from './args.js';

describe('parseCliArgs', () => {
  it('handles help, global flags anywhere, and simple calls', () => {
    expect(parseCliArgs([]).command).toEqual({ kind: 'help' });
    expect(parseCliArgs(['status', '--json', '--socket=x', '--timeout', '50'])).toMatchObject({
      global: { json: true, socket: 'x', timeoutMs: 50 },
      command: { method: 'app.status', params: {} },
    });
    for (const [name, method] of Object.entries({
      describe: 'api.describe',
      version: 'api.version',
      show: 'app.show',
      devices: 'devices.list',
    }))
      expect(parseCliArgs([name]).command).toEqual({ kind: 'call', method, params: {} });
  });

  it('parses raw calls and rejects non-object JSON', () => {
    expect(parseCliArgs(['call', 'custom.method', '{"a":1}']).command).toEqual({
      kind: 'call',
      method: 'custom.method',
      params: { a: 1 },
    });
    for (const value of ['[]', 'null', '1', 'true', '"x"', '{'])
      expect(() => parseCliArgs(['call', 'x', value])).toThrow(UsageError);
  });

  it('maps recording, projects, and export options without defaults', () => {
    expect(
      parseCliArgs([
        'record',
        'start',
        '--source=s1',
        '--out',
        'videos',
        '--no-mic',
        '--camera',
        '--remember-source',
      ]).command,
    ).toEqual({
      kind: 'call',
      method: 'recording.start',
      params: {
        sourceId: 's1',
        outputDir: path.resolve('videos'),
        mic: false,
        camera: true,
        rememberSource: true,
      },
    });
    expect(parseCliArgs(['record', 'pause']).command).toEqual({
      kind: 'call',
      method: 'recording.pause',
      params: {},
    });
    expect(parseCliArgs(['sources', 'forget']).command).toEqual({
      kind: 'call',
      method: 'sources.forget',
      params: {},
    });
    expect(parseCliArgs(['projects', 'list', '--dir=.', '--limit', '2']).command).toEqual({
      kind: 'call',
      method: 'projects.list',
      params: { dir: path.resolve('.'), limit: 2 },
    });
    expect(parseCliArgs(['projects', 'get', 'demo']).command).toEqual({
      kind: 'call',
      method: 'projects.get',
      params: { projectDir: path.resolve('demo') },
    });
    expect(
      parseCliArgs([
        'export',
        'demo',
        '--out=out.mp4',
        '--encoder=hardware',
        '--overwrite',
        '--wait',
      ]).command,
    ).toEqual({
      kind: 'call',
      method: 'export.start',
      params: {
        projectDir: path.resolve('demo'),
        output: path.resolve('out.mp4'),
        encoder: 'hardware',
        overwrite: true,
        wait: true,
      },
    });
    expect(parseCliArgs(['export', 'wait', 'e1', '--timeout-ms=10']).command).toEqual({
      kind: 'call',
      method: 'export.wait',
      params: { exportId: 'e1', timeoutMs: 10 },
    });
  });

  it('parses settings, events, and mcp', () => {
    expect(parseCliArgs(['settings', 'get']).command).toEqual({
      kind: 'call',
      method: 'settings.get',
      params: {},
    });
    expect(
      parseCliArgs(['settings', 'set', 'a=true', 'b=null', 'c=1.5', 'd=hello']).command,
    ).toEqual({
      kind: 'call',
      method: 'settings.set',
      params: { values: { a: true, b: null, c: 1.5, d: 'hello' } },
    });
    expect(parseCliArgs(['events', 'recording.started']).command).toEqual({
      kind: 'events',
      events: ['recording.started'],
    });
    expect(parseCliArgs(['mcp']).command).toEqual({ kind: 'mcp' });
  });

  it.each([
    ['status', 'extra'],
    ['wat'],
    ['--bad'],
    ['projects', 'list', '--limit=0'],
    ['export', 'x', '--encoder=wrong'],
    ['settings', 'set', 'bad'],
    ['record', 'start', '--source'],
    ['--socket'],
    ['--timeout=-1'],
  ])('rejects invalid usage: %j', (...argv) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
  });
});
