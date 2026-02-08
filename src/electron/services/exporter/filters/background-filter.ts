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

    const canvasW = canvasSize.width;
    const canvasH = canvasSize.height;
    const videoDuration = context.videoDuration;

    if (compositorConfig.backgroundPath) {
      const bgPath = compositorConfig.backgroundPath.replace(/\\/g, '/').replace(/:/g, '\\:');

      // scale input -> [vsc], load bg image scaled to canvas -> [bg], then overlay centered
      const complex =
        `[0:v]scale=${layout.width}:${layout.height}:flags=lanczos[vsc];` +
        `movie=${bgPath},scale=${canvasW}:${canvasH}[bg];` +
        `[bg][vsc]overlay=${layout.x}:${layout.y}`;

      return [complex];
    } else {
      const bgColor =
        compositorConfig.backgroundColor || context.project.backgroundColor || '#000000';

      // If transparent, just scale the video without adding a background
      if (bgColor === 'transparent') {
        const complex = `scale=${layout.width}:${layout.height}:flags=lanczos,pad=${canvasW}:${canvasH}:${layout.x}:${layout.y}:color=black@0`;
        return [complex];
      }

      const ffmpegColor = bgColor.startsWith('#') ? bgColor.slice(1) : bgColor;

      // create solid color background with duration matching video to prevent infinite frames
      // The color filter generates infinite frames by default, so we must specify duration
      const complex =
        `color=s=${canvasW}x${canvasH}:c=0x${ffmpegColor}:d=${videoDuration}[bg];` +
        `[0:v]scale=${layout.width}:${layout.height}:flags=lanczos[vsc];` +
        `[bg][vsc]overlay=${layout.x}:${layout.y}:shortest=1`;

      return [complex];
    }
  },
};
