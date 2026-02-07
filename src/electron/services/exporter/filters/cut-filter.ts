/**
 * Cut Filter
 *
 * Removes specified time regions from the video during export.
 * Uses FFmpeg's select and setpts filters to exclude cut regions
 * and reset timestamps for seamless output.
 */

import type { ExportFilter, FilterContext } from './base-filter.js';

export const cutFilter: ExportFilter = {
  name: 'cut',
  priority: 5, // Apply before background/scaling to cut at source resolution

  isEnabled(context: FilterContext): boolean {
    // Only enable if there are cuts defined
    return context.project.cuts && context.project.cuts.length > 0;
  },

  getVideoFilters(context: FilterContext): string[] | null {
    const cuts = context.project.cuts;
    if (!cuts || cuts.length === 0) return null;

    // Sort cuts by start time
    const sortedCuts = [...cuts].sort((a, b) => a.startMs - b.startMs);

    // Build the select expression to exclude cut regions
    // select='not(between(t,s1,e1)+between(t,s2,e2)+...)'
    const betweenExpressions = sortedCuts.map((cut) => {
      const startSec = cut.startMs / 1000;
      const endSec = cut.endMs / 1000;
      return `between(t\\,${startSec}\\,${endSec})`;
    });

    // Join with + (logical OR in FFmpeg select)
    const selectExpr = `select='not(${betweenExpressions.join('+')})'`;

    // Reset PTS to ensure continuous playback after cuts
    // N/FRAME_RATE/TB recomputes timestamps based on frame number
    const setptsExpr = 'setpts=N/FRAME_RATE/TB';

    // Return both filters to be joined in the pipeline
    return [`${selectExpr},${setptsExpr}`];
  },
};

/**
 * Get audio filters for cuts (to sync audio with video cuts)
 * This is a helper that can be used separately if the exporter
 * supports audio filter chains.
 */
export function getAudioCutFilters(context: FilterContext): string[] | null {
  const cuts = context.project.cuts;
  if (!cuts || cuts.length === 0) return null;

  const sortedCuts = [...cuts].sort((a, b) => a.startMs - b.startMs);

  const betweenExpressions = sortedCuts.map((cut) => {
    const startSec = cut.startMs / 1000;
    const endSec = cut.endMs / 1000;
    return `between(t\\,${startSec}\\,${endSec})`;
  });

  const aselectExpr = `aselect='not(${betweenExpressions.join('+')})'`;
  const asetptsExpr = 'asetpts=N/SR/TB';

  return [`${aselectExpr},${asetptsExpr}`];
}
