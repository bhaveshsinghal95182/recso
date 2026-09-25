import { describe, expect, it } from 'vitest';

import { timeToPercent } from './timeline-scale';

/**
 * The playhead is positioned straight off this, so anything it returns outside
 * 0-100 renders outside the track. That is not hypothetical: the native engine
 * clamps its clock to the duration the *decoder* reports, which can sit a frame
 * past the length the editor derived from the project, and the playhead walked
 * off the right-hand edge.
 */
describe('timeToPercent', () => {
  it('places a timestamp proportionally', () => {
    expect(timeToPercent(0, 10_000)).toBe(0);
    expect(timeToPercent(2_500, 10_000)).toBe(25);
    expect(timeToPercent(10_000, 10_000)).toBe(100);
  });

  it('keeps the playhead on the track when a clock reads long', () => {
    // The real case: a container reporting 10000ms whose last frame is at 10033.
    expect(timeToPercent(10_033, 10_000)).toBe(100);
  });

  it.each([
    ['far past the end', 20_000, 10_000],
    ['absurdly past the end', Number.MAX_SAFE_INTEGER, 10_000],
    ['before the start', -1, 10_000],
    ['infinite', Number.POSITIVE_INFINITY, 10_000],
    ['not a number', Number.NaN, 10_000],
  ])('stays within the track when the time is %s', (_label, time, duration) => {
    const percent = timeToPercent(time, duration);

    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(100);
  });

  it('treats an unknown duration as the start rather than the end', () => {
    // A zero duration means "not loaded yet". Dividing by it would give
    // Infinity, and pinning the playhead to the far right of an empty timeline.
    expect(timeToPercent(5_000, 0)).toBe(0);
    expect(timeToPercent(5_000, -1)).toBe(0);
  });
});
