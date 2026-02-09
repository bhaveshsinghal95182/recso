/**
 * CompositorService Types
 * Defines interfaces for layout calculations and compositing configuration.
 */

/** Size dimensions */
export interface Size {
  width: number;
  height: number;
}

/** Rectangle with position and size */
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Layout configuration options */
export interface LayoutConfig {
  /** Padding around the video as a percentage (0-1). Default: 0.05 (5%) */
  padding: number;
  /** Maximum scale factor when window is smaller than canvas. Default: 0.9 */
  maxScale: number;
  /** Whether to scale up small windows to fill more space */
  scaleUp: boolean;
}

/** Result of layout calculation */
export interface LayoutResult {
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

/** Full compositor configuration */
export interface CompositorConfig {
  /** Path to background image, or null for solid color */
  backgroundPath: string | null;
  /** Solid background color (hex) when no image is set */
  backgroundColor: string;
  /** Target canvas dimensions */
  canvasSize: Size;
  /** Layout configuration */
  layout: LayoutConfig;
}

/** Default compositor configuration */
export const DEFAULT_COMPOSITOR_CONFIG: CompositorConfig = {
  backgroundPath: null,
  backgroundColor: '#000000',
  canvasSize: { width: 1920, height: 1080 },
  layout: {
    padding: 0.05,
    maxScale: 0.9,
    scaleUp: true,
  },
};
