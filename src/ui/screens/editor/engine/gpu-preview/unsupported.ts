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
  /**
   * Whether this is worth refusing the engine over.
   *
   * `blocking` means the output would be *wrong* -- a camera visible where it
   * should be hidden, a zoom that never happens, layers in the wrong order.
   * Those send an export back to the Canvas2D path, slow and memory-bound as it
   * is, because a fast export of the wrong video is not an export.
   *
   * `cosmetic` means the picture is right and slightly plainer. Those are drawn
   * without the flourish and reported instead, because refusing over one would
   * mean the engine never ran at all: the default webcam style carries three
   * blurred shadow layers, so treating that as blocking sent *every* export with
   * a camera down the old path -- including the large ones the engine exists
   * for.
   */
  severity: 'blocking' | 'cosmetic';
}

export function unsupportedFeatures(config: CompositionConfig): UnsupportedFeature[] {
  const missing: UnsupportedFeature[] = [];

  if (config.webcam?.enabled && config.webcam.shadows?.some((shadow) => shadow.blur > 0)) {
    missing.push({
      label: 'Webcam shadow',
      detail: 'needs a blur pass; the box, its radius and its border do render',
      severity: 'cosmetic',
    });
  }

  if (config.webcamZoomRegions?.length) {
    missing.push({
      label: 'Webcam zoom regions',
      detail: 'per-region camera size and the full-canvas transition',
      severity: 'blocking',
    });
  }

  if (config.layerStates?.length) {
    const order = config.layerStates.map((state) => state.id).join(',');
    if (order !== 'background,video,cursor,webcam') {
      missing.push({
        label: 'Layer reordering',
        detail: 'the engine draws background, video, webcam, cursor in that order',
        severity: 'blocking',
      });
    }
  }

  if (config.zooms?.length && !config.zoomRegions?.length) {
    missing.push({
      label: 'Legacy zoom keyframes',
      detail: 'only zoom regions are read; re-save the project to convert them',
      severity: 'blocking',
    });
  }

  return missing;
}
