import { describe, expect, it } from 'vitest';

import type { ZoomRegion } from '@/types';

import {
  GROW_ZOOM_CEILING,
  GROW_ZOOM_STEP,
  isGrowSaturated,
  MAX_HEIGHT_RATIO,
  resolveGrowMaxZoom,
  resolveRegionHeightRatio,
  resolveRegionSizeMode,
} from './webcam-region-sizing';

function region(overrides: Partial<ZoomRegion> = {}): ZoomRegion {
  return {
    id: 'r1',
    startMs: 0,
    endMs: 1_000,
    zoomLevel: 1,
    focalX: 0.5,
    focalY: 0.5,
    easeDurationMs: 200,
    ...overrides,
  };
}

/**
 * Grow resolves to `base * zoom`, clamped at the height ceiling, so it stops
 * doing anything once that product saturates. The slider used to offer 1x-5x
 * regardless: at a 34% base everything past 2.2x was dead travel, and at the
 * 75% maximum the whole control did nothing with no sign that it wouldn't.
 */
describe('resolveGrowMaxZoom', () => {
  it.each([
    [0.08, 5],
    [0.15, 5],
    [0.26, 2.8],
    [0.34, 2.2],
    [0.42, 1.7],
    [0.6, 1.2],
    [0.75, 1],
  ])('tops out at a %f base', (base, expected) => {
    expect(resolveGrowMaxZoom(base)).toBe(expected);
  });

  it.each([0.08, 0.15, 0.26, 0.34, 0.42, 0.6, 0.75])(
    'never offers a zoom that overshoots the ceiling at a %f base',
    (base) => {
      const reached = resolveRegionHeightRatio(
        region({ zoomLevel: resolveGrowMaxZoom(base) }),
        base,
      );

      expect(reached).toBeLessThanOrEqual(MAX_HEIGHT_RATIO);
    },
  );

  it.each([0.08, 0.15, 0.26, 0.34, 0.42, 0.6])(
    'still changes the size at the top of its track at a %f base',
    (base) => {
      // The property that matters more than any single number: every position
      // the slider offers has to do something, or the control is lying.
      const max = resolveGrowMaxZoom(base);
      const top = resolveRegionHeightRatio(region({ zoomLevel: max }), base);
      const justBelow = resolveRegionHeightRatio(region({ zoomLevel: max - GROW_ZOOM_STEP }), base);

      expect(top).toBeGreaterThan(justBelow);
    },
  );

  it('never exceeds the slider ceiling, however small the base', () => {
    expect(resolveGrowMaxZoom(0.001)).toBe(GROW_ZOOM_CEILING);
    expect(resolveGrowMaxZoom(0)).toBe(GROW_ZOOM_CEILING);
  });
});

describe('isGrowSaturated', () => {
  it('is saturated at the maximum base size', () => {
    expect(isGrowSaturated(MAX_HEIGHT_RATIO)).toBe(true);
  });

  it('is saturated within one step of the ceiling', () => {
    // 70% could technically reach 75% at 1.07x, which the 0.1 step cannot
    // express -- so there is no usable travel and the control says so.
    expect(isGrowSaturated(0.7)).toBe(true);
  });

  it('is not saturated at the default base size', () => {
    expect(isGrowSaturated(0.34)).toBe(false);
  });
});

/**
 * The data model offers three overlapping ways to state a size. The mode picker
 * makes them exclusive; this is the resolution order it relies on.
 */
describe('resolveRegionSizeMode', () => {
  it('falls back to grow with no region', () => {
    expect(resolveRegionSizeMode(undefined)).toBe('grow');
  });

  it('reads a bare zoom level as grow', () => {
    expect(resolveRegionSizeMode(region({ zoomLevel: 2 }))).toBe('grow');
  });

  it('reads an explicit height as exact', () => {
    expect(resolveRegionSizeMode(region({ zoomLevel: 2, webcamHeightRatio: 0.5 }))).toBe('exact');
  });

  it('lets full screen win over both', () => {
    expect(
      resolveRegionSizeMode(
        region({ zoomLevel: 2, webcamHeightRatio: 0.5, webcamFullScreen: true }),
      ),
    ).toBe('fill');
  });
});

describe('resolveRegionHeightRatio', () => {
  it('scales the base by the zoom level in grow mode', () => {
    expect(resolveRegionHeightRatio(region({ zoomLevel: 2 }), 0.3)).toBeCloseTo(0.6);
  });

  it('ignores the zoom level when an explicit height is set', () => {
    expect(resolveRegionHeightRatio(region({ zoomLevel: 5, webcamHeightRatio: 0.4 }), 0.34)).toBe(
      0.4,
    );
  });

  it('clamps to the same bounds the size control uses', () => {
    expect(resolveRegionHeightRatio(region({ zoomLevel: 5 }), 0.6)).toBe(MAX_HEIGHT_RATIO);
    expect(resolveRegionHeightRatio(region({ webcamHeightRatio: 0.01 }), 0.34)).toBe(0.08);
  });
});
