/**
 * Base Filter Interface
 *
 * Defines the plugin interface for FFmpeg export filters.
 * Each filter can modify the FFmpeg command chain to add effects.
 *
 * To add a new filter:
 * 1. Create a new file implementing ExportFilter
 * 2. Register it in filters/index.ts
 */

import type { ExportConfig } from '../../../types/exporter.types.js';
import type { Project } from '../../../types/project.types.js';

/**
 * Context passed to filters for building the FFmpeg command
 */
export interface FilterContext {
  /** The project being exported */
  project: Project;
  /** Export configuration from UI */
  config: ExportConfig;
  /** Output dimensions (resolved from config) */
  outputWidth: number;
  outputHeight: number;
  /** Duration of the source video in seconds */
  videoDuration: number;
  /** Actual input video dimensions (from Remotion intermediate render) */
  inputWidth?: number;
  inputHeight?: number;
}

/**
 * Base interface for FFmpeg filter plugins.
 * Each filter can modify the FFmpeg command chain.
 */
export interface ExportFilter {
  /** Unique filter name for identification */
  name: string;

  /** Priority determines order of application (lower = applied first) */
  priority: number;

  /**
   * Check if this filter should be applied for the current export.
   * Return false to skip this filter.
   */
  isEnabled(context: FilterContext): boolean;

  /**
   * Apply the filter to the FFmpeg command.
   * Returns the video filter string(s) to add to the filter chain.
   *
   * @param context - Filter context with project and config
   * @returns Array of FFmpeg video filter strings, or null to skip
   */
  getVideoFilters(context: FilterContext): string[] | null;
}
