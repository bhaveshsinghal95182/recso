/**
 * Where the Automation API listens, and making that place safe to listen in.
 *
 * Local only, and guarded by the operating system rather than a password: on
 * Linux (and macOS) a Unix socket inside a directory only this user can enter;
 * on Windows a named pipe whose name carries the user's name. Pure functions of
 * `platform` so both branches are tested on either OS -- the CLI imports this
 * too, and must never pull in Electron.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export type Transport =
  | { kind: 'unix'; dir: string; path: string }
  | { kind: 'pipe'; path: string };

export interface TransportEnvironment {
  env: Record<string, string | undefined>;
  username: string;
  /** `os.tmpdir()`, the fallback when there is no `XDG_RUNTIME_DIR`. */
  tmpdir: string;
}

/** Only characters that are safe in a pipe name and a file name. */
function safeName(username: string): string {
  const cleaned = username.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'user';
}

/**
 * The socket or pipe for this user.
 *
 * `RECSO_AUTOMATION_SOCKET` overrides it, for tests that run a second server
 * next to a real one.
 */
export function transportPath(
  platform: NodeJS.Platform,
  environment: TransportEnvironment,
): Transport {
  const override = environment.env.RECSO_AUTOMATION_SOCKET;

  if (platform === 'win32') {
    return {
      kind: 'pipe',
      path: override || `\\\\.\\pipe\\recso-api-${safeName(environment.username)}`,
    };
  }

  if (override) {
    return { kind: 'unix', dir: path.posix.dirname(override), path: override };
  }

  // XDG_RUNTIME_DIR is already private to the user and cleared at logout. The
  // fallback (macOS, or a bare session) lives in the shared temp directory, so
  // the user's name keeps two users' directories apart.
  const runtimeDir = environment.env.XDG_RUNTIME_DIR;
  const dir = runtimeDir
    ? path.posix.join(runtimeDir, 'recso')
    : path.posix.join(environment.tmpdir, `recso-${safeName(environment.username)}`);
  return { kind: 'unix', dir, path: path.posix.join(dir, 'api.sock') };
}

export class TransportUnsafeError extends Error {}

export interface SocketDirFs {
  mkdirSync: typeof fs.mkdirSync;
  lstatSync: typeof fs.lstatSync;
  chmodSync: typeof fs.chmodSync;
}

/**
 * Create the socket's directory as 0700 and check it is really ours.
 *
 * A directory someone else created (or a symlink planted where it should be)
 * could let them read the socket's traffic or swap the socket for their own,
 * so starting is refused instead.
 */
export function prepareSocketDir(dir: string, uid: number, fileSystem: SocketDirFs = fs): void {
  fileSystem.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const stats = fileSystem.lstatSync(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new TransportUnsafeError(`${dir} is not a plain directory; refusing to listen there`);
  }
  if (stats.uid !== uid) {
    throw new TransportUnsafeError(
      `${dir} belongs to user ${stats.uid}, not ${uid}; refusing to listen there`,
    );
  }
  if ((stats.mode & 0o077) !== 0) {
    fileSystem.chmodSync(dir, 0o700);
  }
}

/** True when something answers on `socketPath`. */
export function isListening(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export class TransportInUseError extends Error {}

/**
 * Clear a socket file a crashed recso left behind.
 *
 * A socket that still answers belongs to a running recso (a second instance,
 * say), and is left alone.
 */
export async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!fs.existsSync(socketPath)) {
    return;
  }
  if (await isListening(socketPath)) {
    throw new TransportInUseError(`another recso is already serving ${socketPath}`);
  }
  fs.unlinkSync(socketPath);
}
