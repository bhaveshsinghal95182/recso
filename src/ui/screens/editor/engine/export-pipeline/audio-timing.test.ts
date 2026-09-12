import { describe, expect, it } from 'vitest';

import { resolveStartDelayCompensationSeconds } from './audio-timing';

describe('resolveStartDelayCompensationSeconds', () => {
  it('aligns a shorter legacy sidecar with the recording end', () => {
    expect(resolveStartDelayCompensationSeconds(10, 9)).toBe(1);
  });

  it('ignores tiny clock noise and implausibly large gaps', () => {
    expect(resolveStartDelayCompensationSeconds(10, 9.98)).toBe(0);
    expect(resolveStartDelayCompensationSeconds(10, 6)).toBe(0);
  });

  it('ignores invalid or longer sidecar durations', () => {
    expect(resolveStartDelayCompensationSeconds(Number.NaN, 9)).toBe(0);
    expect(resolveStartDelayCompensationSeconds(10, Number.POSITIVE_INFINITY)).toBe(0);
    expect(resolveStartDelayCompensationSeconds(10, 11)).toBe(0);
  });
});
