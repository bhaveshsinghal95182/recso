/** Locate recso without loading Electron into the Node CLI process. */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface LaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export interface LaunchContext {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  execPath: string;
  cliPath: string;
  exists: (p: string) => boolean;
  readFile?: (p: string) => string;
}

export function launchPlan(context: LaunchContext): LaunchPlan | null {
  const env = { ...context.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const command =
    context.env.RECSO_APP ||
    context.env.APPIMAGE ||
    (context.env.ELECTRON_RUN_AS_NODE === '1' ? context.execPath : undefined);
  if (command) return { command, args: ['--background'], env };

  let dir = path.dirname(context.cliPath);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (
      context.exists(manifest) &&
      context.exists(path.join(dir, 'node_modules/electron/package.json'))
    ) {
      try {
        if (
          JSON.parse((context.readFile ?? ((p) => fs.readFileSync(p, 'utf8')))(manifest)).name ===
          'recso'
        ) {
          const binary =
            context.platform === 'win32'
              ? 'electron.exe'
              : context.platform === 'darwin'
                ? 'Electron.app/Contents/MacOS/Electron'
                : 'electron';
          return {
            command: path.join(dir, 'node_modules/electron/dist', binary),
            args: [dir, '--background'],
            env,
          };
        }
      } catch {
        /* A different or unreadable checkout is not a launch target. */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function launchRecso(plan: LaunchPlan): void {
  spawn(plan.command, plan.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: plan.env,
  }).unref();
}

function closeProbe(connection: unknown): void {
  if (
    connection &&
    typeof connection === 'object' &&
    'close' in connection &&
    typeof connection.close === 'function'
  )
    connection.close();
}

export async function waitForSocket(
  connect: () => Promise<unknown>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const probe = connect().then((connection) => {
        if (expired) closeProbe(connection);
        return connection;
      });
      const connection = await Promise.race([
        probe,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            resolve(undefined);
          }, remaining);
        }),
      ]);
      if (expired) return false;
      closeProbe(connection);
      return true;
    } catch {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, left)));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
