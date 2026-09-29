import { describe, expect, it } from 'vitest';

import type { DesktopSource } from '../types/recorder.types.js';
import {
  defaultRecordingName,
  describeSource,
  pickSource,
  startFailureReason,
} from './recording-helpers.js';

function source(id: string, extra: Partial<DesktopSource> = {}): DesktopSource {
  return { id, name: id, thumbnailDataUrl: '', isScreen: false, ...extra };
}

describe('defaultRecordingName', () => {
  it('matches the recorder screen', () => {
    expect(defaultRecordingName(new Date('2026-09-30T08:15:42.123Z'))).toBe(
      'recording_2026-09-30-08-15-42',
    );
  });
});

describe('describeSource', () => {
  it('calls every Linux source a portal source', () => {
    expect(describeSource(source('screen:portal', { isScreen: true }), 'linux').kind).toBe(
      'portal',
    );
  });

  it('tells screens from windows on Windows', () => {
    expect(
      describeSource(source('screen:0', { isScreen: true, isPrimary: true }), 'win32'),
    ).toEqual({ id: 'screen:0', name: 'screen:0', kind: 'screen', isPrimary: true });
    expect(describeSource(source('window:42'), 'win32')).toEqual({
      id: 'window:42',
      name: 'window:42',
      kind: 'window',
      isPrimary: false,
    });
  });
});

describe('pickSource', () => {
  const sources = [
    source('window:1'),
    source('screen:1', { isScreen: true }),
    source('screen:0', { isScreen: true, isPrimary: true }),
  ];

  it('takes the one asked for', () => {
    expect(pickSource(sources, 'window:1').id).toBe('window:1');
  });

  it('defaults to the primary screen, then any screen, then anything', () => {
    expect(pickSource(sources).id).toBe('screen:0');
    expect(pickSource(sources.slice(0, 2)).id).toBe('screen:1');
    expect(pickSource(sources.slice(0, 1)).id).toBe('window:1');
  });

  it('fails with source_unavailable', () => {
    expect(() => pickSource(sources, 'window:9')).toThrow(
      expect.objectContaining({ reason: 'source_unavailable' }),
    );
    expect(() => pickSource([])).toThrow(expect.objectContaining({ reason: 'source_unavailable' }));
  });
});

describe('startFailureReason', () => {
  it('reports a cancelled picker as cancelled', () => {
    expect(startFailureReason('Screen capture was cancelled')).toBe('cancelled');
    expect(startFailureReason('encoder exploded')).toBe('recording_failed');
  });
});
