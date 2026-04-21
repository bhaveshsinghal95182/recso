/**
 * Zoom Types
 *
 * Defines the structure for zoom regions used to apply
 * zoom effects during video export.
 */

/** A timestamped focal-point change within a zoom region */
export interface FocalKeyframe {
  /** Absolute time (ms from video start) when the focal point reaches this position */
  timestampMs: number;
  /** Focal point X (0-1, normalised to video area) */
  focalX: number;
  /** Focal point Y (0-1, normalised to video area) */
  focalY: number;
}

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
  /** Optional webcam canvas height override (0-1) for webcam zoom timelines. */
  webcamHeightRatio?: number;
  /** Optional full-canvas webcam mode for webcam zoom timelines. */
  webcamFullScreen?: boolean;
  /**
   * Optional focal-point keyframes produced by smart pan.
   * Sorted by timestampMs ascending.
   */
  focalKeyframes?: FocalKeyframe[];
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
