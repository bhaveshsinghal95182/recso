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
 * Build zoom expression using nested if() statements for multiple regions
 *
 * For each zoom region with ease in/out:
 * - Phase 1 (ease in):  zoom from 1 to zoomLevel over easeFrames
 * - Phase 2 (hold):     maintain zoomLevel
 * - Phase 3 (ease out): zoom from zoomLevel back to 1 over easeFrames
 *
 * Multiple regions are handled by checking each region's end frame and nesting
 * the next region's expression as the fallback.
 */
function buildZoomExpression(regions: ZoomRegion[]): string {
  if (regions.length === 0) return '1';

  // Build expression recursively, processing regions in order
  return buildZoomForRegion(regions, 0);
}

function buildZoomForRegion(regions: ZoomRegion[], index: number): string {
  // Base case: no more regions, return default zoom
  if (index >= regions.length) return '1';

  const r = regions[index];
  const startFrame = Math.round((r.startMs / 1000) * FPS);
  const endFrame = Math.round((r.endMs / 1000) * FPS);
  const easeFrames = Math.max(1, Math.round((r.easeDurationMs / 1000) * FPS));

  const easeInEnd = startFrame + easeFrames;
  const easeOutStart = endFrame - easeFrames;

  const z = fmt(r.zoomLevel);
  const zMinus1 = fmt(r.zoomLevel - 1);

  const easeIn = `1+${zMinus1}*(on-${startFrame})/${easeFrames}`;
  const easeOut = `${z}-${zMinus1}*(on-${easeOutStart})/${easeFrames}`;

  // Get the expression for the next region (or default '1')
  const nextExpr = buildZoomForRegion(regions, index + 1);

  // Structure: if before this region's start, check next regions
  //            else if in this region, apply zoom phases
  //            else (after this region), check next regions
  return (
    `if(lt(on,${startFrame}),${nextExpr},` +
    `if(lt(on,${easeInEnd}),${easeIn},` +
    `if(lt(on,${easeOutStart}),${z},` +
    `if(lt(on,${endFrame}),${easeOut},` +
    `${nextExpr}))))`
  );
}

/**
 * Build X position expression for multiple regions
 *
 * Centers the zoom on the focal point using:
 * x = (iw - iw/zoom) * focalX
 */
function buildXExpression(regions: ZoomRegion[]): string {
  const defaultX = '(iw-iw/zoom)/2';
  if (regions.length === 0) return defaultX;

  return buildXForRegion(regions, 0, defaultX);
}

function buildXForRegion(regions: ZoomRegion[], index: number, defaultX: string): string {
  if (index >= regions.length) return defaultX;

  const r = regions[index];
  const startFrame = Math.round((r.startMs / 1000) * FPS);
  const endFrame = Math.round((r.endMs / 1000) * FPS);

  const fx = fmt(r.focalX);
  const activeX = `(iw-iw/zoom)*${fx}`;

  const nextExpr = buildXForRegion(regions, index + 1, defaultX);

  return (
    `if(lt(on,${startFrame}),${nextExpr},` + `if(lt(on,${endFrame}),${activeX},` + `${nextExpr}))`
  );
}

/**
 * Build Y position expression for multiple regions
 *
 * Same logic as X but for vertical positioning
 */
function buildYExpression(regions: ZoomRegion[]): string {
  const defaultY = '(ih-ih/zoom)/2';
  if (regions.length === 0) return defaultY;

  return buildYForRegion(regions, 0, defaultY);
}

function buildYForRegion(regions: ZoomRegion[], index: number, defaultY: string): string {
  if (index >= regions.length) return defaultY;

  const r = regions[index];
  const startFrame = Math.round((r.startMs / 1000) * FPS);
  const endFrame = Math.round((r.endMs / 1000) * FPS);

  const fy = fmt(r.focalY);
  const activeY = `(ih-ih/zoom)*${fy}`;

  const nextExpr = buildYForRegion(regions, index + 1, defaultY);

  return (
    `if(lt(on,${startFrame}),${nextExpr},` + `if(lt(on,${endFrame}),${activeY},` + `${nextExpr}))`
  );
}
