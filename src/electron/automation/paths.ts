/**
 * Path rules for API input, per platform.
 *
 * Paths must be absolute: a relative one would resolve against recso's own
 * working directory, which is nothing the caller can see. Windows paths are
 * judged by `path.win32` (drive letters, UNC shares), everything else by
 * `path.posix`, so both are tested wherever the tests run.
 */

import path from 'node:path';

import { AutomationError, ErrorCode } from './protocol.js';

export function pathModule(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * True for a path that names one place on its own: `/x`, `C:\x`, `\\server\share\x`.
 *
 * `\x` and `C:x` are "absolute" to `path.win32` but depend on the current
 * drive or directory, so they are refused.
 */
export function isAbsolutePath(platform: NodeJS.Platform, candidate: string): boolean {
  if (platform !== 'win32') {
    return path.posix.isAbsolute(candidate);
  }
  return /^[A-Za-z]:[\\/]/.test(candidate) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(candidate);
}

/** Throw `invalid_params` unless `candidate` is absolute; returns it normalised. */
export function requireAbsolutePath(
  platform: NodeJS.Platform,
  candidate: string,
  field: string,
): string {
  if (!isAbsolutePath(platform, candidate)) {
    throw new AutomationError('invalid_params', `${field} must be an absolute path: ${candidate}`, {
      code: ErrorCode.InvalidParams,
    });
  }
  return pathModule(platform).normalize(candidate);
}
