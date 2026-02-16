/**
 * Remotion Composition Input Props.
 *
 * These types are self-contained so they work in both:
 * - The renderer process (Vite/React preview via @remotion/player)
 * - The main process (Electron export via @remotion/renderer)
 *
 * Both the UI and Electron share structurally identical Project/ExportConfig types,
 * so this interface is compatible with either source.
 */

export type BackgroundPattern = 'none' | 'gradient-blobs' | 'diagonal-lines';

/** Layout information for positioning the video on the canvas */
export interface CompositionLayout {
  /** X offset on the canvas */
  x: number;
  /** Y offset on the canvas */
  y: number;
  /** Rendered width on canvas */
  width: number;
  /** Rendered height on canvas */
  height: number;
  /** Scale factor applied (1.0 = original size) */
  scale: number;
}

/** A timestamped focal-point change within a zoom region */
export interface CompositionFocalKeyframe {
  timestampMs: number;
  focalX: number;
  focalY: number;
}

/** Zoom region data needed by the composition */
export interface CompositionZoomRegion {
  id: string;
  startMs: number;
  endMs: number;
  zoomLevel: number;
  /** Initial focal point X (0-1, normalized) */
  focalX: number;
  /** Initial focal point Y (0-1, normalized) */
  focalY: number;
  /** Ease duration in milliseconds */
  easeDurationMs: number;
  /** Optional focal-point keyframes for smart pan */
  focalKeyframes?: CompositionFocalKeyframe[];
}

/**
 * Props passed to Remotion composition at render time.
 *
 * This is the contract between the host (Player or Renderer) and the composition.
 */
export interface RemotionInputProps {
  /** Index signature required by Remotion's LooseComponentType */
  [key: string]: unknown;
  /** Absolute path to the raw video file */
  videoSrc: string;

  /** Background color (hex string like '#1a1a2e') */
  backgroundColor: string;

  /** Optional background image path */
  backgroundPath?: string;

  /**
   * Optional CSS background pattern.
   *
   * Patterns can define their own container styles (bg color, text color),
   * which can be overridden by `backgroundColor` if needed.
   */
  backgroundPattern?: BackgroundPattern;

  /** Pre-calculated layout for video positioning on canvas */
  layout: CompositionLayout;

  /** Canvas dimensions */
  canvasWidth: number;
  canvasHeight: number;

  /** Zoom regions to animate */
  zoomRegions: CompositionZoomRegion[];
}
