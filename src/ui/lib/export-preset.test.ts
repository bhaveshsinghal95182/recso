import { describe, expect, it } from 'vitest';

import { parseExportPreset } from './export-preset';

describe('parseExportPreset', () => {
  it('splits a preset into resolution and quality', () => {
    expect(parseExportPreset('720p-low')).toEqual(['720p', 'low']);
    expect(parseExportPreset('4k-lossless')).toEqual(['4k', 'lossless']);
  });

  it('falls back to 1080p high', () => {
    expect(parseExportPreset(undefined)).toEqual(['1080p', 'high']);
    expect(parseExportPreset('8k-ultra')).toEqual(['1080p', 'high']);
    expect(parseExportPreset('custom-high')).toEqual(['1080p', 'high']);
  });
});
