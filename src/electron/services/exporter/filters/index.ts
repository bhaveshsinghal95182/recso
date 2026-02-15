/**
 * Filter Registry
 *
 * Central registry for all export filters.
 * Add new filters here to include them in the export pipeline.
 */

import type { ExportConfig } from '../../../types/exporter.types.js';
import { RESOLUTION_MAP } from '../../../types/exporter.types.js';
import type { Project } from '../../../types/project.types.js';
// Kept for reference/fallback, but not used in pipeline:
// import { backgroundFilter } from './background-filter.js';
// import { zoomFilter } from './zoom-filter.js';
import type { ExportFilter, FilterContext } from './base-filter.js';
import { cutFilter } from './cut-filter.js';
import { scalingFilter } from './scaling-filter.js';

/**
 * All registered filters.
 * Add new filters to this array to include them in exports.
 *
 * IMPORTANT: Background and zoom filters are NOT applied here because:
 * - Remotion already applies them during rendering with WYSIWYG accuracy
 * - Applying them again in FFmpeg post-processing would double-process
 * - The filter code (backgroundFilter, zoomFilter) is kept for reference/fallback
 *
 * Active filters (post-processing only):
 * - cutFilter: Remove unwanted segments (must happen after effects)
 * - scalingFilter: Upscale to target resolution
 */
const filters: ExportFilter[] = [
  // backgroundFilter, // DISABLED - Remotion handles this
  // zoomFilter, // DISABLED - Remotion handles this
  cutFilter, // Priority 50 - Cut AFTER compositing to avoid duration issues
  scalingFilter, // Priority 90 - Scale to output resolution last
];

/**
 * Create a filter context from project and config
 */
export function createFilterContext(
  project: Project,
  config: ExportConfig,
  videoDuration: number,
): FilterContext {
  const { width, height } = getOutputDimensions(config);

  return {
    project,
    config,
    outputWidth: width,
    outputHeight: height,
    videoDuration,
  };
}

/**
 * Get all enabled filters sorted by priority
 */
export function getEnabledFilters(context: FilterContext): ExportFilter[] {
  return filters.filter((f) => f.isEnabled(context)).sort((a, b) => a.priority - b.priority);
}

/**
 * Get all filters (for debugging/testing)
 */
export function getAllFilters(): ExportFilter[] {
  return [...filters];
}

/**
 * Register a new filter at runtime
 */
export function registerFilter(filter: ExportFilter): void {
  filters.push(filter);
}

/**
 * Helper to get output dimensions from config
 */
export function getOutputDimensions(config: ExportConfig): { width: number; height: number } {
  if (config.resolution === 'custom') {
    return {
      width: config.customWidth || 1920,
      height: config.customHeight || 1080,
    };
  }
  return RESOLUTION_MAP[config.resolution] || { width: 1920, height: 1080 };
}

export type { ExportFilter, FilterContext } from './base-filter.js';
