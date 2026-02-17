/**
 * Scaling Filter
 *
 * Scales the complete video (with background and all effects applied) to the target output resolution.
 * This filter should run last (high priority number) to ensure all effects are applied at original
 * resolution first, then the entire result is upscaled/downscaled to match the export settings.
 */

import type { ExportFilter, FilterContext } from './base-filter.js';

/**
 * Resolution scaling filter
 */
export const scalingFilter: ExportFilter = {
  name: 'scaling',
  priority: 90, // Applied last - scales the final composed video

  isEnabled(context: FilterContext): boolean {
    const { project, outputWidth, outputHeight, inputWidth, inputHeight } = context;

    // Use actual input dimensions from Remotion render if available,
    // otherwise fallback to original video dimensions
    const sourceWidth = inputWidth ?? project.videoDimensions.width;
    const sourceHeight = inputHeight ?? project.videoDimensions.height;

    // Only enable if output resolution differs from source resolution
    return outputWidth !== sourceWidth || outputHeight !== sourceHeight;
  },

  getVideoFilters(context: FilterContext): string[] {
    const { outputWidth, outputHeight } = context;

    // Scale to exact output dimensions
    // Using Lanczos for high quality upscaling/downscaling
    return [`scale=${outputWidth}:${outputHeight}:flags=lanczos`];
  },
};
