export interface GradientStop {
  color: string;
  position: number;
}

export interface BackgroundConfig {
  enabled: boolean;
  type: 'color' | 'linearGradient' | 'radialGradient' | 'crossHatch';
  color?: string;
  angle?: number;
  stops?: GradientStop[];
  cx?: number;
  cy?: number;
  radiusX?: number;
  radiusY?: number;
  backgroundColor?: string;
  lineColor?: string;
  lineWidth?: number;
  cellSize?: number;
  mask?: {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    innerStop: number;
    outerStop: number;
  };
}

export interface VideoConfig {
  scale: number;
  borderRadius: number;
  border: {
    width: number;
    color: string;
  };
}

export interface CompositionLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface CompositionFocalKeyframe {
  timestampMs: number;
  focalX: number;
  focalY: number;
}

export interface CompositionZoomRegion {
  id: string;
  startMs: number;
  endMs: number;
  zoomLevel: number;
  focalX: number;
  focalY: number;
  easeDurationMs: number;
  focalKeyframes?: CompositionFocalKeyframe[];
}

export interface CompositionCutRegion {
  id: string;
  startMs: number;
  endMs: number;
}

export type CursorStyle = 'default' | 'pointer' | 'crosshair' | 'custom';

export interface CompositionCursorEvent {
  timestampMs: number;
  x: number;
  y: number;
  normalizedX?: number;
  normalizedY?: number;
  cursorDataUrl?: string;
  cursorHotspotX?: number;
  cursorHotspotY?: number;
  cursorHandleHex?: string;
  eventType: 'click' | 'mousemove';
  button?: 'left' | 'right' | 'middle';
}

export interface CompositionCursorConfig {
  enabled: boolean;
  size: number;
  style: CursorStyle;
  customImagePath?: string;
  showClickAnimations: boolean;
  clickAnimationScale: number;
  clickDisplayDuration: number;
  showMotionBlur: boolean;
  motionBlurStrength: number;
  sourceWidth: number;
  sourceHeight: number;
  events: CompositionCursorEvent[];
}

export type BackgroundPatternConfig = BackgroundConfig;

export interface RemotionInputProps {
  [key: string]: unknown;
  videoSrc: string;
  backgroundColor: string;
  backgroundPath?: string;
  backgroundPattern?: BackgroundPatternConfig;
  layout: CompositionLayout;
  canvasWidth: number;
  canvasHeight: number;
  zoomRegions: CompositionZoomRegion[];
  cuts?: CompositionCutRegion[];
  sourceDurationMs?: number;
}

export interface ZoomKeyframe {
  startTime: number;
  endTime: number;
  focalPoint: { x: number; y: number };
  multiplier: number;
  easeIn?: number;
  easeOut?: number;
}

export interface CompositionConfig {
  background: BackgroundConfig;
  video: VideoConfig;
  layout?: CompositionLayout;
  cursor?: CompositionCursorConfig;
  zooms: ZoomKeyframe[];
  zoomRegions?: CompositionZoomRegion[];
  cuts?: CompositionCutRegion[];
}

export type Canvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface FrameVideoSource {
  draw(ctx: Canvas2DContext, x: number, y: number, width: number, height: number): void;
}

export interface VideoLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface ZoomState {
  scale: number;
  pivotX: number;
  pivotY: number;
}
