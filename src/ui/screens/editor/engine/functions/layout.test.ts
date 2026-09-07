import { describe, expect, it } from 'vitest';

import type { WebcamOverlayConfig } from '../types';
import { computeWebcamLayout, computeWebcamRegionLayout } from './layout';

const W = 1920;
const H = 1080;
const MARGIN = 32;

function webcam(overrides: Partial<WebcamOverlayConfig> = {}): WebcamOverlayConfig {
  return {
    enabled: true,
    anchor: 'center',
    aspectRatio: 3 / 4,
    heightRatio: 0.34,
    marginPx: MARGIN,
    borderRadius: 24,
    opacity: 1,
    border: { width: 0, color: '#000' },
    shadows: [],
    ...overrides,
  };
}

const SIZES = [0.15, 0.34, 0.5, 0.75];
const ANCHORS = ['top-left', 'top-right', 'center', 'bottom-left', 'bottom-right'] as const;

/**
 * `computeWebcamLayout` short-circuits on an explicit `layout` -- the rect you
 * get from dragging the camera on the preview. The region path cleared that
 * field so the box would be recomputed at the region's height, and lost the
 * position with it, falling through to `anchor`, which dragging never updates.
 * A camera dragged to the bottom-right jumped to wherever the anchor still
 * pointed the moment a region began, then slid back at the end.
 */
describe('computeWebcamRegionLayout', () => {
  // The reported case: anchor never changed from centre, camera dragged to the
  // bottom-right, so the two disagree about where the camera is.
  const dragged = webcam({
    layout: computeWebcamLayout(W, H, webcam({ anchor: 'bottom-right' })),
  });
  const draggedCentreX = dragged.layout!.x + dragged.layout!.width / 2;

  it('starts a dragged camera where it was dragged', () => {
    expect(computeWebcamLayout(W, H, dragged).x).toBe(dragged.layout!.x);
  });

  it.each(SIZES)('does not pull a dragged camera to the anchor at %f', (target) => {
    const box = computeWebcamRegionLayout(W, H, dragged, target);
    const anchored = computeWebcamRegionLayout(W, H, webcam(), target);

    // The bug in one assertion: these used to be the same box.
    expect(box.x).not.toBe(anchored.x);
    expect(box.x + box.width / 2).toBeGreaterThan(W / 2);
  });

  it.each(SIZES)('grows about where the camera actually sits at %f', (target) => {
    const box = computeWebcamRegionLayout(W, H, dragged, target);
    const anchored = computeWebcamRegionLayout(W, H, webcam(), target);

    expect(Math.abs(box.x + box.width / 2 - draggedCentreX)).toBeLessThanOrEqual(
      Math.abs(anchored.x + anchored.width / 2 - draggedCentreX),
    );
  });

  it.each(SIZES)('keeps a dragged camera inside the margin at %f', (target) => {
    const box = computeWebcamRegionLayout(W, H, dragged, target);

    expect(box.x).toBeGreaterThanOrEqual(MARGIN);
    expect(box.y).toBeGreaterThanOrEqual(MARGIN);
    expect(box.x + box.width).toBeLessThanOrEqual(W - MARGIN);
    expect(box.y + box.height).toBeLessThanOrEqual(H - MARGIN);
  });

  it.each(SIZES)('resizes a dragged camera to the height the region asked for at %f', (target) => {
    expect(computeWebcamRegionLayout(W, H, dragged, target).height).toBe(
      computeWebcamLayout(W, H, webcam({ heightRatio: target })).height,
    );
  });

  // The other half of the fix: a camera placed with the anchor picker has no
  // custom layout and must keep resolving exactly as it always did.
  it.each(ANCHORS)('leaves an anchored camera on the "%s" grid position', (anchor) => {
    const config = webcam({ anchor });

    expect(computeWebcamRegionLayout(W, H, config, 0.5)).toEqual(
      computeWebcamLayout(W, H, webcam({ anchor, heightRatio: 0.5 })),
    );
  });

  it('keeps a camera dragged into a corner in that corner as it grows', () => {
    const corner = webcam({ layout: { x: 1613, y: 681, width: 275, height: 367, scale: 0.34 } });
    const grown = computeWebcamRegionLayout(W, H, corner, 0.75);

    // Pinned to the far corner by the margin clamp rather than drifting inward.
    expect(grown.x + grown.width).toBe(W - MARGIN);
    expect(grown.y + grown.height).toBe(H - MARGIN);
  });
});
