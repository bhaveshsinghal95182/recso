/**
 * Filter Registry
 *
 * Central registry for all export filters.
 * Add new filters here to include them in the export pipeline.
 */

import type { ExportConfig } from '../../../types/exporter.types.js';
import { RESOLUTION_MAP } from '../../../types/exporter.types.js';
import type { Project } from '../../../types/project.types.js';
import { backgroundFilter } from './background-filter.js';
import type { ExportFilter, FilterContext } from './base-filter.js';
import { scalingFilter } from './scaling-filter.js';

/**
 * All registered filters.
 * Add new filters to this array to include them in exports.
 */
const filters: ExportFilter[] = [
  backgroundFilter, // Priority 10 - Apply background at original resolution
  scalingFilter, // Priority 90 - Scale to output resolution last
  // Future filters:
  // cursorOverlayFilter,
  // zoomFilter,
  // watermarkFilter,
];

/**
 * Create a filter context from project and config
 */
export function createFilterContext(project: Project, config: ExportConfig): FilterContext {
  const { width, height } = getOutputDimensions(config);

  return {
    project,
    config,
    outputWidth: width,
    outputHeight: height,
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
