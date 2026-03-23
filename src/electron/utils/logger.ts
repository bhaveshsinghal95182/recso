import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import log from 'electron-log';

const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_LOG_FILES = 5;
const LOG_FILE_NAME = 'main.log';

type LoggerLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly';

let isInitialized = false;
let mirrorToStdout = false;

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

let hasConsoleInterception = false;

function toSafePayload(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  return value;
}

function pruneArchivedLogs(logPath: string): void {
  try {
    const logDir = path.dirname(logPath);
    const baseName = path.basename(logPath, path.extname(logPath));

    const candidates = fs
      .readdirSync(logDir)
      .filter((fileName) => fileName.startsWith(baseName))
      .map((fileName) => ({
        fileName,
        fullPath: path.join(logDir, fileName),
      }))
      .map((entry) => ({
        ...entry,
        modifiedMs: fs.statSync(entry.fullPath).mtimeMs,
      }))
      .sort((a, b) => b.modifiedMs - a.modifiedMs);

    for (const stale of candidates.slice(MAX_LOG_FILES)) {
      fs.rmSync(stale.fullPath, { force: true });
    }
  } catch {
    // Log pruning is best-effort and should never block startup.
  }
}

function write(level: LoggerLevel, ...args: unknown[]): void {
  log[level](...args.map(toSafePayload));
}

function installConsoleInterception(): void {
  if (hasConsoleInterception) {
    return;
  }

  hasConsoleInterception = true;

  console.log = (...args: unknown[]) => {
    write('info', ...args);
    if (mirrorToStdout) {
      originalConsole.log(...args);
    }
  };

  console.info = (...args: unknown[]) => {
    write('info', ...args);
    if (mirrorToStdout) {
      originalConsole.info(...args);
    }
  };

  console.warn = (...args: unknown[]) => {
    write('warn', ...args);
    if (mirrorToStdout) {
      originalConsole.warn(...args);
    }
  };

  console.error = (...args: unknown[]) => {
    write('error', ...args);
    if (mirrorToStdout) {
      originalConsole.error(...args);
    }
  };

  console.debug = (...args: unknown[]) => {
    write('debug', ...args);
    if (mirrorToStdout) {
      originalConsole.debug(...args);
    }
  };
}

export function initializeLogging(options: { mirrorConsole: boolean }): void {
  if (isInitialized) {
    return;
  }

  mirrorToStdout = options.mirrorConsole;
  const logPath = path.join(app.getPath('userData'), 'logs', LOG_FILE_NAME);

  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  log.transports.console.level = false;
  log.transports.file.level = 'info';
  log.transports.file.maxSize = MAX_LOG_SIZE_BYTES;
  log.transports.file.resolvePathFn = () => logPath;

  installConsoleInterception();

  isInitialized = true;
  pruneArchivedLogs(logPath);
  write('info', '[Logger] File logging initialized at:', logPath);
}

export const logger = {
  error: (...args: unknown[]) => write('error', ...args),
  warn: (...args: unknown[]) => write('warn', ...args),
  info: (...args: unknown[]) => write('info', ...args),
  debug: (...args: unknown[]) => write('debug', ...args),
};
