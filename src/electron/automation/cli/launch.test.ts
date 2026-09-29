/** Test discovery with an injected filesystem so host installs cannot affect results. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { type LaunchContext, launchPlan, waitForSocket } from './launch.js';

const root = path.resolve('/work/recso');
function context(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    platform: 'linux',
    env: { ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' },
    execPath: '/bin/recso',
    cliPath: path.join(root, 'dist/cli.js'),
    exists: () => false,
    ...overrides,
  };
}

describe('launchPlan', () => {
  it('honors executable, AppImage, and packaged priorities', () => {
    expect(
      launchPlan(
        context({ env: { RECSO_APP: '/app', APPIMAGE: '/image', ELECTRON_RUN_AS_NODE: '1' } }),
      ),
    ).toEqual({
      command: '/app',
      args: ['--background'],
      env: { RECSO_APP: '/app', APPIMAGE: '/image' },
    });
    expect(
      launchPlan(context({ env: { APPIMAGE: '/image', ELECTRON_RUN_AS_NODE: '1' } }))?.command,
    ).toBe('/image');
    expect(launchPlan(context())?.command).toBe('/bin/recso');
  });

  it.each([
    ['linux', 'electron'],
    ['win32', 'electron.exe'],
    ['darwin', 'Electron.app/Contents/MacOS/Electron'],
  ] as const)('finds development Electron on %s', (platform, binary) => {
    const plan = launchPlan(
      context({
        platform,
        env: {},
        exists: (p) =>
          p === path.join(root, 'package.json') ||
          p === path.join(root, 'node_modules/electron/package.json'),
        readFile: () => '{"name":"recso"}',
      }),
    );
    expect(plan).toEqual({
      command: path.join(root, 'node_modules/electron/dist', binary),
      args: [root, '--background'],
      env: {},
    });
  });

  it('returns null when checkout cannot be found', () => {
    expect(launchPlan(context({ env: {}, exists: () => false }))).toBeNull();
  });
});

describe('waitForSocket', () => {
  it('retries until connected and closes probe clients', async () => {
    let attempts = 0;
    let closed = false;
    expect(
      await waitForSocket(
        async () => {
          if (++attempts < 3) throw Error('offline');
          return {
            close: () => {
              closed = true;
            },
          };
        },
        100,
        1,
      ),
    ).toBe(true);
    expect([attempts, closed]).toEqual([3, true]);
  });
  it('times out', async () => {
    expect(
      await waitForSocket(
        async () => {
          throw Error('offline');
        },
        5,
        1,
      ),
    ).toBe(false);
  });
  it('bounds a slow probe and closes it if it connects later', async () => {
    let closed = false;
    const started = Date.now();
    expect(
      await waitForSocket(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  close: () => {
                    closed = true;
                  },
                }),
              30,
            ),
          ),
        5,
        1,
      ),
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(25);
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(closed).toBe(true);
  });
});
