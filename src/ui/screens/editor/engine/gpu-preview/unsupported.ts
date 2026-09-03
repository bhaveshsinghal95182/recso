/**
 * What this composition uses that the engine cannot draw yet.
 *
 * The engine is not at parity with the Canvas2D compositor, and the dangerous
 * failure mode is not a crash -- it is a preview that looks plausible while
 * quietly missing a layer. Anything the mapper drops is named here so it shows
 * up in the UI instead of being discovered in an export.
 *
 * Entries come off this list as `docs/ENGINE-FEATURE-MAP.md` gets shorter.
 */

import type { CompositionConfig } from '../types';

export interface UnsupportedFeature {
  /** What the user would notice. */
  label: string;
  /** Why it is missing, in one clause. */
  detail: string;
}

export function unsupportedFeatures(config: CompositionConfig): UnsupportedFeature[] {
  const missing: UnsupportedFeature[] = [];
  const cursor = config.cursor;

  if (config.webcam?.enabled && config.webcam.shadows?.some((shadow) => shadow.blur > 0)) {
    missing.push({
      label: 'Webcam shadow',
      detail: 'needs a blur pass; the box, its radius and its border do render',
    });
  }

  if (config.webcamCuts?.length) {
    missing.push({
      label: 'Webcam cuts',
      detail: 'the camera stays visible through spans that should hide it',
    });
  }

  if (config.webcamZoomRegions?.length) {
    missing.push({
      label: 'Webcam zoom regions',
      detail: 'per-region camera size and the full-canvas transition',
    });
  }

  if (cursor?.enabled) {
    if (cursor.showClickAnimations) {
      missing.push({ label: 'Click animations', detail: 'the pointer draws without them' });
    }
    if (cursor.showMotionBlur) {
      missing.push({ label: 'Cursor motion blur', detail: 'the pointer draws without a trail' });
    }
    if (cursor.cursorRegionOverrides?.length) {
      missing.push({
        label: 'Cursor region overrides',
        detail: 'one bitmap is used for the whole track',
      });
    }
    if (cursor.events.some((event) => event.cursorDataUrl)) {
      missing.push({
        label: 'Per-event cursor shapes',
        detail: 'the pointer will not change over text fields and links',
      });
    }
  }

  if (config.layerStates?.length) {
    const order = config.layerStates.map((state) => state.id).join(',');
    if (order !== 'background,video,cursor,webcam') {
      missing.push({
        label: 'Layer reordering',
        detail: 'the engine draws background, video, webcam, cursor in that order',
      });
    }
  }

  if (config.zooms?.length && !config.zoomRegions?.length) {
    missing.push({
      label: 'Legacy zoom keyframes',
      detail: 'only zoom regions are read; re-save the project to convert them',
    });
  }

  return missing;
}
