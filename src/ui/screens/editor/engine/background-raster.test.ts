import { describe, expect, it } from 'vitest';

import type { Project } from '@/types';

import { resolveBackgroundMode, resolveCanvasBackgroundLayers } from './background-raster';

const pattern = {
  id: 'orange-glow',
  label: 'Orange Glow',
  style: { background: 'radial-gradient(circle, red, transparent)' },
  containerStyle: { backgroundColor: '#000000' },
};

function project(fields: Partial<Project>): Project {
  return fields as Project;
}

describe('resolveBackgroundMode', () => {
  it('takes the mode the project states', () => {
    // Even when the other fields disagree -- someone who picked a pattern and
    // then switched back to a colour still has the pattern stored.
    expect(
      resolveBackgroundMode(project({ backgroundMode: 'color', backgroundPattern: pattern })),
    ).toBe('color');
    expect(resolveBackgroundMode(project({ backgroundMode: 'pattern' }))).toBe('pattern');
    expect(resolveBackgroundMode(project({ backgroundMode: 'image' }))).toBe('image');
  });

  it('infers the mode for projects saved before there was one', () => {
    expect(resolveBackgroundMode(project({ backgroundPath: 'C:/wall.png' }))).toBe('image');
    expect(resolveBackgroundMode(project({ backgroundPattern: pattern }))).toBe('pattern');
    expect(resolveBackgroundMode(project({}))).toBe('color');
    expect(resolveBackgroundMode(null)).toBe('color');
  });

  it('does not count the none preset as a pattern', () => {
    const none = { ...pattern, id: 'none' };
    expect(resolveBackgroundMode(project({ backgroundPattern: none }))).toBe('color');
  });
});

describe('resolveCanvasBackgroundLayers', () => {
  it('is nothing at all in full-bleed', () => {
    // The recording covers the canvas, so anything drawn here is overdrawn.
    expect(
      resolveCanvasBackgroundLayers(
        project({ canvasBackgroundEnabled: false, backgroundPattern: pattern }),
        '',
      ),
    ).toBeNull();
  });

  it('is the colour alone when that is all there is', () => {
    const layers = resolveCanvasBackgroundLayers(project({ backgroundColor: '#123456' }), '');
    expect(layers).toEqual({ container: { backgroundColor: '#123456' } });
  });

  it('falls back to black rather than leaving the colour unset', () => {
    expect(resolveCanvasBackgroundLayers(project({}), '')?.container).toEqual({
      backgroundColor: '#000000',
    });
  });

  it('puts the preset over the container colour it brought with it', () => {
    const layers = resolveCanvasBackgroundLayers(
      project({
        backgroundMode: 'pattern',
        backgroundColor: '#ffffff',
        backgroundPattern: pattern,
      }),
      '',
    );

    // The preset's own container colour wins over the project's, which is what
    // makes a glow read as a glow rather than as a wash over white.
    expect(layers?.container).toEqual({ backgroundColor: '#000000' });
    expect(layers?.pattern).toEqual(pattern.style);
    expect(layers?.imageUrl).toBeUndefined();
  });

  it('takes the image over a pattern the project is still carrying', () => {
    const layers = resolveCanvasBackgroundLayers(
      project({ backgroundMode: 'image', backgroundPattern: pattern }),
      'file:///wall.png',
    );

    expect(layers?.imageUrl).toBe('file:///wall.png');
    expect(layers?.pattern).toBeUndefined();
  });

  it('is the colour alone when the image mode has no image', () => {
    // A half-set image mode should draw the colour, not nothing -- the engine
    // clears to it and the exporter skips the layer entirely.
    const layers = resolveCanvasBackgroundLayers(
      project({ backgroundMode: 'image', backgroundColor: '#222222' }),
      '',
    );

    expect(layers).toEqual({ container: { backgroundColor: '#222222' } });
  });
});
