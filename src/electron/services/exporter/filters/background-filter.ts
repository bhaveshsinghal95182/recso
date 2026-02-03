/**
 * Background Filter
 *
 * Applies background color/image and centers the source video on the output canvas.
 * - Scales down full-screen videos and adds padding
 * - Centers smaller videos and fills remaining space with background
 */

import { calculateLayout, getConfig } from '../../compositor.service.js';
import type { ExportFilter, FilterContext } from './base-filter.js';

export const backgroundFilter: ExportFilter = {
  name: 'background',
  priority: 10,

  isEnabled(_context: FilterContext): boolean {
    return true;
  },

  getVideoFilters(context: FilterContext): string[] {
    const compositorConfig = getConfig();

    const canvasSize = compositorConfig.canvasSize;
    const videoDims = context.project.videoDimensions;
    const layout = calculateLayout(videoDims, canvasSize);

    const filters: string[] = [];

    // Step 1: Scale the video
    filters.push(`scale=${layout.width}:${layout.height}:flags=lanczos`);

    // Step 2: Add background
    if (compositorConfig.backgroundPath) {
      // Background image - use complex filter
      const bgPath = compositorConfig.backgroundPath.replace(/\\/g, '/').replace(/:/g, '\\:');

      filters.push(
        `movie=${bgPath},scale=${canvasSize.width}:${canvasSize.height}[bg];` +
          `[bg][0:v]overlay=${layout.x}:${layout.y}`,
      );
    } else {
      // Background color - simple padding
      const bgColor =
        compositorConfig.backgroundColor || context.project.backgroundColor || '#000000';
      const ffmpegColor = bgColor.startsWith('#') ? bgColor.slice(1) : bgColor;

      filters.push(
        `pad=${canvasSize.width}:${canvasSize.height}:${layout.x}:${layout.y}:0x${ffmpegColor}`,
      );
    }

    return filters;
  },
};
