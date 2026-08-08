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
  /** Padding around the video as a percentage (0-1). Default: 0.04 (4%) */
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

/** 3x3 placement grid for the webcam overlay. */
export type WebcamAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface WebcamLayoutRequest {
  /** Optional anchor point on canvas. Default: bottom-right */
  anchor?: WebcamAnchor;
  /** Webcam width/height ratio. Portrait 3:4 is 0.75. Default: 3 / 4 */
  aspectRatio?: number;
  /** Webcam height as ratio of canvas height. Default: 0.34 */
  heightRatio?: number;
  /** Margin from canvas edges in pixels. Default: 24 */
  marginPx?: number;
}

export type WebcamLayoutResult = LayoutResult;

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
  /** Whether canvas background is enabled (true for framed, false for full-bleed) */
  canvasBackgroundEnabled: boolean;
}

/** Default compositor configuration */
export const DEFAULT_COMPOSITOR_CONFIG: CompositorConfig = {
  backgroundPath: null,
  backgroundColor: '#000000',
  canvasSize: { width: 1920, height: 1080 },
  layout: {
    padding: 0.04,
    maxScale: 0.9,
    scaleUp: true,
  },
  canvasBackgroundEnabled: true,
};
