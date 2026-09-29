import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareSocketDir, transportPath, TransportUnsafeError } from './transport.js';

const base = { username: 'ana', tmpdir: '/tmp' };

describe('transportPath', () => {
  it('uses a socket under XDG_RUNTIME_DIR on Linux', () => {
    expect(transportPath('linux', { ...base, env: { XDG_RUNTIME_DIR: '/run/user/1000' } })).toEqual(
      {
        kind: 'unix',
        dir: '/run/user/1000/recso',
        path: '/run/user/1000/recso/api.sock',
      },
    );
  });

  it('falls back to a per-user directory in the temp dir without XDG_RUNTIME_DIR', () => {
    expect(transportPath('darwin', { ...base, env: {} })).toEqual({
      kind: 'unix',
      dir: '/tmp/recso-ana',
      path: '/tmp/recso-ana/api.sock',
    });
  });

  it('uses a per-user named pipe on Windows, whatever XDG_RUNTIME_DIR says', () => {
    expect(
      transportPath('win32', { ...base, username: 'Ana Maria', env: { XDG_RUNTIME_DIR: '/x' } }),
    ).toEqual({ kind: 'pipe', path: '\\\\.\\pipe\\recso-api-Ana_Maria' });
  });

  it('keeps odd characters out of the pipe and directory names', () => {
    expect(transportPath('win32', { ...base, username: 'DOMAIN\\bob', env: {} }).path).toBe(
      '\\\\.\\pipe\\recso-api-DOMAIN_bob',
    );
    expect(transportPath('linux', { ...base, username: '../x', env: {} }).path).toBe(
      '/tmp/recso-.._x/api.sock',
    );
  });

  it('honours RECSO_AUTOMATION_SOCKET on both platforms', () => {
    expect(
      transportPath('linux', { ...base, env: { RECSO_AUTOMATION_SOCKET: '/t/a/api.sock' } }),
    ).toEqual({ kind: 'unix', dir: '/t/a', path: '/t/a/api.sock' });
    expect(
      transportPath('win32', { ...base, env: { RECSO_AUTOMATION_SOCKET: '\\\\.\\pipe\\t' } }),
    ).toEqual({ kind: 'pipe', path: '\\\\.\\pipe\\t' });
  });
});

describe('prepareSocketDir', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-transport-'));
    made.push(dir);
    return dir;
  }

  it('creates the directory private to the user', () => {
    const dir = path.join(scratch(), 'recso');
    prepareSocketDir(dir, process.getuid!());
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('tightens a directory that is too open', () => {
    const dir = path.join(scratch(), 'recso');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    prepareSocketDir(dir, process.getuid!());
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a directory that belongs to someone else', () => {
    const dir = path.join(scratch(), 'recso');
    expect(() => prepareSocketDir(dir, process.getuid!() + 1)).toThrow(TransportUnsafeError);
  });

  it('refuses a symlink planted where the directory should be', () => {
    const root = scratch();
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'recso'));
    expect(() => prepareSocketDir(path.join(root, 'recso'), process.getuid!())).toThrow(
      TransportUnsafeError,
    );
  });
});
