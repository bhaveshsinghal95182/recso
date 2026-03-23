import { ipcMain } from 'electron';

import { logger } from '../utils/logger.js';

type RendererLogLevel = 'error' | 'warn' | 'info' | 'debug';

const allowedLevels: Set<RendererLogLevel> = new Set(['error', 'warn', 'info', 'debug']);

function isRendererLogLevel(level: unknown): level is RendererLogLevel {
  return typeof level === 'string' && allowedLevels.has(level as RendererLogLevel);
}

export function registerLoggingHandlers(): void {
  ipcMain.on('logging:write', (_event, level: unknown, ...args: unknown[]) => {
    const safeLevel: RendererLogLevel = isRendererLogLevel(level) ? level : 'info';
    const payload = ['[Renderer]', ...args];

    switch (safeLevel) {
      case 'error':
        logger.error(...payload);
        break;
      case 'warn':
        logger.warn(...payload);
        break;
      case 'debug':
        logger.debug(...payload);
        break;
      default:
        logger.info(...payload);
        break;
    }
  });
}
