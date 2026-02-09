/**
 * Zoom Types
 *
 * Defines the structure for zoom regions used to apply
 * zoom effects during video export.
 */

/**
 * A region of the video where zoom is applied
 */
export interface ZoomRegion {
  /** Unique identifier for the zoom region */
  id: string;
  /** Start time of the zoom in milliseconds */
  startMs: number;
  /** End time of the zoom in milliseconds */
  endMs: number;
  /** Zoom level (1.0 = no zoom, 2.0 = 2x zoom, etc.) */
  zoomLevel: number;
  /** Focal point X position (0.0 to 1.0, relative to canvas width) */
  focalX: number;
  /** Focal point Y position (0.0 to 1.0, relative to canvas height) */
  focalY: number;
  /** Duration of ease in/out animation in milliseconds */
  easeDurationMs: number;
}

/**
 * Default zoom region values
 */
export const DEFAULT_ZOOM_REGION: Omit<ZoomRegion, 'id' | 'startMs' | 'endMs'> = {
  zoomLevel: 1.5,
  focalX: 0.5,
  focalY: 0.5,
  easeDurationMs: 300,
};
