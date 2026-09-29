/**
 * The pure parts of recording over the Automation API, apart from the
 * recorder so they can be tested without Electron.
 */

import type { DesktopSource } from '../types/recorder.types.js';
import { AutomationError } from './protocol.js';
import type { CaptureSource } from './services.js';

/** The recorder UI's own default name, so API recordings look like button ones. */
export function defaultRecordingName(now: Date): string {
  return `recording_${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
}

export function describeSource(source: DesktopSource, platform: NodeJS.Platform): CaptureSource {
  return {
    id: source.id,
    name: source.name,
    kind: platform === 'linux' ? 'portal' : source.isScreen ? 'screen' : 'window',
    isPrimary: source.isPrimary === true,
  };
}

/** The source to record: the one asked for, else the primary screen, as the recorder picks. */
export function pickSource(sources: DesktopSource[], requested?: string): DesktopSource {
  if (requested !== undefined) {
    const found = sources.find((source) => source.id === requested);
    if (!found) {
      throw new AutomationError(
        'source_unavailable',
        `no capture source ${requested}; list them with devices.list`,
      );
    }
    return found;
  }
  const fallback =
    sources.find((source) => source.isScreen && source.isPrimary) ??
    sources.find((source) => source.isScreen) ??
    sources[0];
  if (!fallback) {
    throw new AutomationError('source_unavailable', 'recso found nothing to record');
  }
  return fallback;
}

export function startFailureReason(error: string): string {
  return /cancel/i.test(error) ? 'cancelled' : 'recording_failed';
}
