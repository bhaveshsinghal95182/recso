/**
 * What this composition uses that the engine cannot draw yet.
 *
 * The engine is not at parity with the Canvas2D compositor, and the dangerous
 * failure mode is not a crash -- it is a preview that looks plausible while
 * quietly missing a layer. Anything the mapper drops is named here so it shows
 * up in the UI instead of being discovered in an export.
 *
 * Entries come off this list as `docs/ENGINE-FEATURE-MAP.md` gets shorter. It
 * is currently empty -- webcam shadows were the last one -- and stays because
 * the next feature the editor grows will need it again.
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

export function unsupportedFeatures(_config: CompositionConfig): UnsupportedFeature[] {
  // Empty, and deliberately still here. The engine draws every composition the
  // editor can describe, but this is the seam that catches the next feature
  // added to the editor and not to the engine -- and the failure it exists to
  // prevent is a preview that looks plausible while quietly missing a layer,
  // which nobody notices until the export.
  return [];
}
