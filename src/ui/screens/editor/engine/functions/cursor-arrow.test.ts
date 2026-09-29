import { describe, expect, it } from 'vitest';

import { glyphSizeFor } from '../gpu-preview/raster';
import { arrowGlyphExtent } from './cursor';

describe('arrowGlyphExtent', () => {
  it('reaches past the tip on every side for the rim and shadow, more below', () => {
    const extent = arrowGlyphExtent(10);
    expect(extent.left).toBeGreaterThan(0);
    expect(extent.top).toBeGreaterThan(0);
    // The arrow itself is 2.2 sizes tall and about 1.34 wide.
    expect(extent.bottom).toBeGreaterThan(22);
    expect(extent.right).toBeGreaterThan(13.3);
    expect(extent.bottom - 22).toBeGreaterThan(extent.top);
  });

  it('scales linearly with the size', () => {
    const one = arrowGlyphExtent(1);
    const five = arrowGlyphExtent(5);
    expect(five.bottom).toBeCloseTo(one.bottom * 5);
    expect(five.left).toBeCloseTo(one.left * 5);
  });

  it('keeps the arrow most of the sprite, so it reads at the size it is shown', () => {
    const extent = arrowGlyphExtent(1);
    expect(2.2 / (extent.top + extent.bottom)).toBeGreaterThan(0.7);
  });
});

describe('glyphSizeFor', () => {
  it('makes the sprite twice as tall as it is shown', () => {
    const unit = arrowGlyphExtent(1);
    const size = glyphSizeFor(unit, 28);
    const sprite = arrowGlyphExtent(size);
    expect(sprite.top + sprite.bottom).toBeCloseTo(56);
  });

  it('falls back to a fixed size without a display height', () => {
    const unit = arrowGlyphExtent(1);
    expect(glyphSizeFor(unit)).toBe(64);
    expect(glyphSizeFor(unit, 0)).toBe(64);
    expect(glyphSizeFor(unit, Number.NaN)).toBe(64);
  });
});
