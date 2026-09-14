import { describe, expect, it } from 'vitest';

import { mapCompositionToSourceTimeMs, mapSourceTimeToCompositionTimeMs } from './cuts';

describe('cut time mapping', () => {
  const cuts = [{ id: 'cut', startMs: 4_000, endMs: 6_000 }];

  it('maps timeline source positions into composition positions', () => {
    expect(mapSourceTimeToCompositionTimeMs(3_000, cuts)).toBe(3_000);
    expect(mapSourceTimeToCompositionTimeMs(5_000, cuts)).toBe(4_000);
    expect(mapSourceTimeToCompositionTimeMs(8_000, cuts)).toBe(6_000);
  });

  it('maps the composition playhead back onto the source timeline', () => {
    expect(mapCompositionToSourceTimeMs(3_000, cuts)).toBe(3_000);
    expect(mapCompositionToSourceTimeMs(4_000, cuts)).toBe(6_000);
    expect(mapCompositionToSourceTimeMs(6_000, cuts)).toBe(8_000);
  });
});
