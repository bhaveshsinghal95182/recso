import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DRAIN_SCRIPT,
  installScript,
  parseDrainReply,
  parseMonitors,
  removeScript,
  startHyprlandClickCapture,
  toPhysical,
} from './hyprland-clicks.js';

interface FakeHyprland {
  socketPath: string;
  requests: string[];
  replies: Record<string, string>;
  close(): Promise<void>;
}

const fakes: Array<{ server: Server; directory: string }> = [];

async function fakeHyprland(): Promise<FakeHyprland> {
  const directory = mkdtempSync(path.join(tmpdir(), 'recso-hyprland-clicks-'));
  const socketPath = path.join(directory, 'socket');
  const requests: string[] = [];
  const replies: Record<string, string> = {
    'j/binds': '[]',
    'j/monitors': JSON.stringify([{ x: 0, y: 0, width: 1920, height: 1080, scale: 1.25 }]),
    eval: 'ok',
    repl: 'clicks\n',
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      const request = Buffer.concat(chunks).toString('utf8');
      requests.push(request);
      const prefix = Object.keys(replies).find((candidate) => request.startsWith(candidate));
      socket.end(prefix === undefined ? '' : replies[prefix]);
    });
  });
  fakes.push({ server, directory });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    requests,
    replies,
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  };
}

afterEach(async () => {
  for (const { server, directory } of fakes.splice(0)) {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('parseMonitors', () => {
  it('converts physical dimensions into logical bounds', () => {
    expect(parseMonitors([{ x: 0, y: 0, width: 1920, height: 1080, scale: 1.25 }])).toEqual([
      { x: 0, y: 0, width: 1536, height: 864, scale: 1.25 },
    ]);
  });

  it('skips bad scales and malformed input', () => {
    const base = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(
      parseMonitors([
        { ...base, scale: 0 },
        { ...base, scale: -1 },
        { ...base, scale: NaN },
        base,
        { ...base, scale: 1 },
      ]),
    ).toEqual([{ ...base, scale: 1 }]);
    expect(parseMonitors(null)).toEqual([]);
    expect(parseMonitors({ ...base, scale: 1 })).toEqual([]);
  });
});

describe('toPhysical', () => {
  const monitors = [
    { x: 0, y: 0, width: 1536, height: 864, scale: 1.25 },
    { x: 1536, y: 0, width: 1920, height: 1080, scale: 1 },
  ];

  it('uses the scale of the containing monitor', () => {
    expect(toPhysical(100, 100, monitors)).toEqual({ x: 125, y: 125 });
    expect(toPhysical(2000, 100, monitors)).toEqual({ x: 2000, y: 100 });
  });

  it('uses the first scale off every monitor without shifting the origin', () => {
    expect(toPhysical(-10, 0, monitors)).toEqual({ x: -12.5, y: 0 });
    expect(toPhysical(10, 20, [])).toEqual({ x: 10, y: 20 });
  });
});

describe('parseDrainReply', () => {
  it('rejects replies without the clicks header', () => {
    expect(parseDrainReply('')).toEqual([]);
    expect(parseDrainReply('error\nleft 10 20 30')).toEqual([]);
  });

  it('keeps valid buttons in order while skipping malformed lines', () => {
    expect(
      parseDrainReply(
        '\ufeff  clicks\nleft 10 20 30\nother 11 20 30\nright nope 2 3\nright -1 2 3\nmiddle 12 -4 5\nright 13 6 7\n',
      ),
    ).toEqual([
      { button: 'left', uptimeSec: 10, x: 20, y: 30 },
      { button: 'middle', uptimeSec: 12, x: -4, y: 5 },
      { button: 'right', uptimeSec: 13, x: 6, y: 7 },
    ]);
  });
});

describe('Lua scripts', () => {
  it('installs one transparent, non-consuming bind per requested button', () => {
    const script = installScript(['left', 'middle']);
    expect(script.match(/hl\.bind\(/g)).toHaveLength(2);
    expect(script).toContain('hl.bind("mouse:272"');
    expect(script).toContain('hl.bind("mouse:274"');
    expect(script).not.toContain('hl.bind("mouse:273"');
    expect(script.match(/non_consuming = true/g)).toHaveLength(2);
    expect(script.match(/transparent = true/g)).toHaveLength(2);
    expect(script.trimStart().startsWith('return')).toBe(false);
  });

  it('removes only installed binds', () => {
    const script = removeScript(['left', 'middle']);
    expect(script).toContain('hl.unbind("mouse:272")');
    expect(script).toContain('hl.unbind("mouse:274")');
    expect(script).not.toContain('mouse:273');
    expect(script).toContain('__recso_clicks = nil');
    expect(DRAIN_SCRIPT).toContain('return "clicks\\n" .. c');
  });
});

// Hyprland is Linux-only, and its IPC (faked here) is a Unix socket.
describe.skipIf(process.platform === 'win32')('Hyprland click capture', () => {
  it('drains clicks with wall-clock timestamps and rounded physical coordinates', async () => {
    const fake = await fakeHyprland();
    const capture = await startHyprlandClickCapture({
      socketPath: fake.socketPath,
      readUptime: async () => 100,
      now: () => 1_700_000_000_000,
    });
    expect(capture).not.toBeNull();
    fake.replies.repl = 'clicks\nright 99.5 10.2 20.4\nleft 99.0 100 100';

    expect(await capture?.drain()).toEqual([
      { button: 'left', atEpochMs: 1_699_999_999_000, x: 125, y: 125 },
      { button: 'right', atEpochMs: 1_699_999_999_500, x: 13, y: 26 },
    ]);
    expect(fake.requests).toEqual([
      'j/binds',
      'j/monitors',
      `eval ${installScript(['left', 'right', 'middle'])}`,
      `repl ${DRAIN_SCRIPT}`,
    ]);
  });

  it('respects a user-owned button during install and removal', async () => {
    const fake = await fakeHyprland();
    fake.replies['j/binds'] = JSON.stringify([{ key: 'mouse:273', modmask: 0 }]);
    const capture = await startHyprlandClickCapture({ socketPath: fake.socketPath });
    expect(capture).not.toBeNull();
    expect(fake.requests[2]).toContain('hl.bind("mouse:272"');
    expect(fake.requests[2]).toContain('hl.bind("mouse:274"');
    expect(fake.requests[2]).not.toContain('hl.bind("mouse:273"');

    await capture?.stop();
    expect(fake.requests[3]).toContain('hl.unbind("mouse:272")');
    expect(fake.requests[3]).toContain('hl.unbind("mouse:274")');
    expect(fake.requests[3]).not.toContain('mouse:273');
  });

  it("clears binds a crashed recording left behind instead of treating them as the user's", async () => {
    const fake = await fakeHyprland();
    fake.replies['j/binds'] = JSON.stringify([
      { key: 'mouse:272', modmask: 0, description: 'recso click capture' },
      { key: 'mouse:274', modmask: 0, description: 'recso click capture' },
    ]);
    const capture = await startHyprlandClickCapture({ socketPath: fake.socketPath });
    expect(capture).not.toBeNull();
    expect(fake.requests).toEqual([
      'j/binds',
      `eval ${removeScript(['left', 'middle'])}`,
      'j/monitors',
      `eval ${installScript(['left', 'right', 'middle'])}`,
    ]);
  });

  it('returns null when Hyprland rejects the Lua install', async () => {
    const fake = await fakeHyprland();
    fake.replies.eval = 'error: Lua config required';
    expect(await startHyprlandClickCapture({ socketPath: fake.socketPath })).toBeNull();
  });

  it('stops only once', async () => {
    const fake = await fakeHyprland();
    const capture = await startHyprlandClickCapture({ socketPath: fake.socketPath });
    expect(capture).not.toBeNull();
    await capture?.stop();
    const requestCount = fake.requests.length;
    await capture?.stop();
    expect(fake.requests).toHaveLength(requestCount);
    expect(fake.requests.filter((request) => request.startsWith('eval '))).toHaveLength(2);
  });

  it('sends every command through a blocking requester instead of the socket when given one', async () => {
    const fake = await fakeHyprland();
    const sent: string[] = [];
    let failing = false;
    const capture = await startHyprlandClickCapture({
      socketPath: fake.socketPath,
      requestSync: (command) => {
        if (failing) throw new Error('Hyprland socket read: timed out');
        sent.push(command);
        if (command === 'j/binds') return '[]';
        if (command === 'j/monitors') return '[]';
        return command.startsWith('repl ') ? 'clicks\nleft 99 10 20' : 'ok';
      },
      readUptime: async () => 100,
      now: () => 5_000,
    });
    expect(capture).not.toBeNull();
    expect(await capture?.drain()).toEqual([{ button: 'left', atEpochMs: 4_000, x: 10, y: 20 }]);
    failing = true;
    expect(await capture?.drain()).toEqual([]);
    failing = false;
    await capture?.stop();
    expect(sent.map((command) => command.split(' ')[0])).toEqual([
      'j/binds',
      'j/monitors',
      'eval',
      'repl',
      'eval',
    ]);
    expect(fake.requests).toEqual([]);
  });

  it('returns an empty drain after the socket server exits', async () => {
    const fake = await fakeHyprland();
    const capture = await startHyprlandClickCapture({ socketPath: fake.socketPath });
    expect(capture).not.toBeNull();
    await fake.close();
    expect(await capture?.drain()).toEqual([]);
  });
});
