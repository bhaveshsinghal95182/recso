/**
 * Zoom Filter - Simplified zoompan using if() conditionals
 *
 * Uses the standard zoompan syntax with nested if() statements
 * for phase-based zoom/ease transitions.
 *
 * Reference: zoompan=z='if(lt(on,N),expr1,expr2)':x=...:y=...:d=DURATION:s=WxH:fps=FPS
 */

import type { ZoomRegion } from '../../../types/zoom.types.js';
import type { ExportFilter, FilterContext } from './base-filter.js';

const FPS = 30;

export const zoomFilter: ExportFilter = {
  name: 'zoom',
  priority: 30,

  isEnabled(context: FilterContext): boolean {
    return !!context.project.zoomRegions?.length;
  },

  getVideoFilters(context: FilterContext): string[] | null {
    const regions = context.project.zoomRegions;
    if (!regions?.length) return null;

    const sorted = [...regions].sort((a, b) => a.startMs - b.startMs);

    // Build simple if()-based expressions
    const zoomExpr = buildZoomExpression(sorted);
    const xExpr = buildXExpression(sorted);
    const yExpr = buildYExpression(sorted);

    const canvasWidth = context.outputWidth || 1920;
    const canvasHeight = context.outputHeight || 1080;

    // d=1 means each input frame produces exactly 1 output frame
    // The 'on' variable increments for each output frame, so it matches input frame index
    const zoompanFilter =
      `zoompan=` +
      `z='${zoomExpr}':` +
      `x='${xExpr}':` +
      `y='${yExpr}':` +
      `d=1:` +
      `s=${canvasWidth}x${canvasHeight}:` +
      `fps=${FPS}`;

    return [zoompanFilter];
  },
};

const fmt = (n: number) => parseFloat(n.toFixed(4)).toString();

/**
 * Build zoom expression using nested if() statements
 *
 * For a zoom region with ease in/out:
 * - Phase 1 (ease in):  zoom from 1 to zoomLevel over easeFrames
 * - Phase 2 (hold):     maintain zoomLevel
 * - Phase 3 (ease out): zoom from zoomLevel back to 1 over easeFrames
 *
 * Example output for single region:
 * if(lt(on,30),1+on/30,if(lt(on,90),2,if(lt(on,120),2-(on-90)/30,1)))
 */
function buildZoomExpression(regions: ZoomRegion[]): string {
  if (regions.length === 0) return '1';

  // For simplicity, handle first region only for now
  // TODO: Support multiple regions with proper nesting
  const r = regions[0];

  const startFrame = Math.round((r.startMs / 1000) * FPS);
  const endFrame = Math.round((r.endMs / 1000) * FPS);
  const easeFrames = Math.max(1, Math.round((r.easeDurationMs / 1000) * FPS));

  const easeInEnd = startFrame + easeFrames;
  const easeOutStart = endFrame - easeFrames;

  const z = fmt(r.zoomLevel);
  const zMinus1 = fmt(r.zoomLevel - 1);

  // Before zoom region: z = 1
  // Ease in: z = 1 + (zoomLevel-1) * (on-startFrame)/easeFrames
  // Hold: z = zoomLevel
  // Ease out: z = zoomLevel - (zoomLevel-1) * (on-easeOutStart)/easeFrames
  // After zoom region: z = 1

  // Nested if structure:
  // if(lt(on,startFrame), 1,                           <- before region
  //   if(lt(on,easeInEnd), 1+(z-1)*(on-start)/ease,    <- ease in
  //     if(lt(on,easeOutStart), z,                     <- hold
  //       if(lt(on,endFrame), z-(z-1)*(on-easeOut)/ease, <- ease out
  //         1                                          <- after region
  //       )
  //     )
  //   )
  // )

  const easeIn = `1+${zMinus1}*(on-${startFrame})/${easeFrames}`;
  const easeOut = `${z}-${zMinus1}*(on-${easeOutStart})/${easeFrames}`;

  return (
    `if(lt(on,${startFrame}),1,` +
    `if(lt(on,${easeInEnd}),${easeIn},` +
    `if(lt(on,${easeOutStart}),${z},` +
    `if(lt(on,${endFrame}),${easeOut},` +
    `1))))`
  );
}

/**
 * Build X position expression
 *
 * Centers the zoom on the focal point using:
 * x = (iw - iw/zoom) * focalX
 *
 * When zoom = 1, x = 0 (no offset needed)
 * When zoom > 1, x positions the zoom window to center on focalX
 */
function buildXExpression(regions: ZoomRegion[]): string {
  if (regions.length === 0) return '(iw-iw/zoom)/2';

  const r = regions[0];
  const startFrame = Math.round((r.startMs / 1000) * FPS);
  const endFrame = Math.round((r.endMs / 1000) * FPS);

  // focalX is 0-1, where 0.5 = center
  const fx = fmt(r.focalX);

  // During zoom: position based on focal point
  // Outside zoom: center (0.5)
  const activeX = `(iw-iw/zoom)*${fx}`;
  const defaultX = `(iw-iw/zoom)/2`;

  return (
    `if(lt(on,${startFrame}),${defaultX},` + `if(lt(on,${endFrame}),${activeX},` + `${defaultX}))`
  );
}

/**
 * Build Y position expression
 *
 * Same logic as X but for vertical positioning
 */
function buildYExpression(regions: ZoomRegion[]): string {
  if (regions.length === 0) return '(ih-ih/zoom)/2';

  const r = regions[0];
  const startFrame = Math.round((r.startMs / 1000) * FPS);
  const endFrame = Math.round((r.endMs / 1000) * FPS);

  const fy = fmt(r.focalY);

  const activeY = `(ih-ih/zoom)*${fy}`;
  const defaultY = `(ih-ih/zoom)/2`;

  return (
    `if(lt(on,${startFrame}),${defaultY},` + `if(lt(on,${endFrame}),${activeY},` + `${defaultY}))`
  );
}
