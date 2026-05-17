/**
 * Project Types for the Editor Service
 *
 * Defines the structure of an editing project, including timeline,
 * cursor configuration, and zoom settings.
 */
/**
 * Cursor style options for rendering
 */
import type { BackgroundPatternConfig } from './background.types.js';
import type { CutRegion } from './cut.types.js';
import type { SpritesheetMeta } from './spritesheet.types.js';
import type { ZoomRegion } from './zoom.types.js';

export type CursorStyle = 'default' | 'pointer' | 'crosshair' | 'custom';
export type ZoomSource = 'screen' | 'webcam';
export type TimelineLayerId = 'main' | 'webcam' | 'zoom-screen' | 'zoom-webcam' | 'cursor';
export type TimelineVisibilityMode = 'editor-only' | 'render-and-export';

export interface TimelineLayer {
  id: TimelineLayerId;
  label: string;
  visible: boolean;
  order: number;
  hideMode: TimelineVisibilityMode;
}

export interface ZoomRegionsBySource {
  screen: ZoomRegion[];
  webcam: ZoomRegion[];
}

/**
 * Configuration for cursor/click rendering
 */
export interface CursorConfig {
  /** Cursor size multiplier (1.0 = normal) */
  size: number;
  /** Cursor style */
  style: CursorStyle;
  /** Custom cursor image path (when style = 'custom') */
  customImagePath?: string;
  /** Show click animations */
  showClickAnimations: boolean;
  /** Click animation scale factor */
  clickAnimationScale: number;
  /** Click indicator duration in ms */
  clickDisplayDuration: number;
  /** Show motion blur trail during fast cursor movement */
  showMotionBlur: boolean;
  /** Motion blur intensity multiplier */
  motionBlurStrength: number;
}

export interface CursorRegionOverride {
  /** Derived cursor timeline region identifier (e.g. cursor-region-0). */
  regionId: string;
  /** Region start time in milliseconds. */
  startMs: number;
  /** Region end time in milliseconds. */
  endMs: number;
  /** Custom image source for this region (data URL or file path). */
  imagePath: string;
}

/**
 * Zoom configuration for the editor preview
 */
export interface ZoomConfig {
  /** Zoom level (1.0 = 100%, 2.0 = 200%) */
  level: number;
  /** Focal point X in base (post-padding) coordinates */
  focalX: number;
  /** Focal point Y in base (post-padding) coordinates */
  focalY: number;
}

export type WebcamOverlayAnchor = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type WebcamOverlayShape = 'circle' | 'rectangle-landscape' | 'rectangle-portrait' | 'square';
export type WebcamOverlaySize = 'small' | 'medium' | 'large';

export interface WebcamShadowLayer {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
}

export interface WebcamOverlayConfig {
  enabled: boolean;
  sourcePath?: string;
  anchor?: WebcamOverlayAnchor;
  shape?: WebcamOverlayShape;
  size?: WebcamOverlaySize;
  aspectRatio?: number;
  heightRatio?: number;
  marginPx?: number;
  borderRadiusPx?: number;
  borderWidthPx?: number;
  borderColor?: string;
  opacity?: number;
  shadows?: WebcamShadowLayer[];
}

/** Crop configuration — normalised 0–1 insets from each edge of the source video. */
export interface CropConfig {
  /** Fraction cropped from the top (0 = no crop, 0.25 = crop 25 % from top) */
  top: number;
  /** Fraction cropped from the left */
  left: number;
  /** Fraction cropped from the bottom */
  bottom: number;
  /** Fraction cropped from the right */
  right: number;
}

/**
 * A single clip on the timeline
 */
export interface TimelineClip {
  id: string;
  /** Start time in source media (ms) */
  sourceStart: number;
  /** End time in source media (ms) */
  sourceEnd: number;
  /** Position on timeline (ms) */
  timelineStart: number;
  /** Playback speed multiplier */
  speed: number;
}

/**
 * A track on the timeline
 */
export interface TimelineTrack {
  id: string;
  type: 'video' | 'audio' | 'cursor';
  clips: TimelineClip[];
  /** Whether this track is visible/audible */
  enabled: boolean;
}

/**
 * Timeline structure
 */
export interface Timeline {
  /** Duration of the timeline in ms */
  duration: number;
  tracks: TimelineTrack[];
}

/**
 * The main project structure
 */
export interface Project {
  /** Unique project ID */
  id: string;
  /** Human-readable project name */
  name: string;
  /** Recording ID this project is based on (for click data lookup) */
  recordingId: string;
  /** Path to the .recso project folder */
  projectFolderPath: string;
  /** Path to the raw video file */
  rawVideoPath: string;
  /** Video dimensions (original) */
  videoDimensions: {
    width: number;
    height: number;
  };
  /** Timeline with tracks and clips */
  timeline: Timeline;
  /** Cursor rendering configuration */
  cursorConfig: CursorConfig;
  /** Optional region-scoped cursor image overrides for timeline cursor regions. */
  cursorRegionOverrides?: CursorRegionOverride[];
  /** Zoom configuration */
  zoomConfig: ZoomConfig;
  /** Spritesheet metadata for timeline thumbnails (null if not generated) */
  spritesheetMeta: SpritesheetMeta | null;
  /** Optional background image path */
  backgroundPath?: string;
  /** Background color (hex) */
  backgroundColor: string;
  /** Optional background pattern */
  backgroundPattern?: BackgroundPatternConfig | null;
  /** Whether canvas background is enabled (defaults to true for backward compatibility) */
  canvasBackgroundEnabled?: boolean;
  /** Optional crop configuration for the source recording */
  cropConfig?: CropConfig | null;
  /** Optional webcam overlay settings */
  webcamOverlay?: WebcamOverlayConfig | null;
  /** Cut regions to exclude from export */
  cuts: CutRegion[];
  /**
   * Legacy screen zoom regions for backward compatibility.
   * New code should prefer zoomRegionsBySource.screen.
   */
  zoomRegions: ZoomRegion[];
  /** Source-scoped zoom regions used by multi-timeline editing. */
  zoomRegionsBySource?: ZoomRegionsBySource;
  /** Timeline visibility and ordering controls. */
  timelineLayers?: TimelineLayer[];
  /** Project creation timestamp */
  createdAt: number;
  /** Last modified timestamp */
  modifiedAt: number;
}

/**
 * Result of cursor/click position lookup
 */
export interface TransformedCursorPosition {
  /** X position on canvas */
  x: number;
  /** Y position on canvas */
  y: number;
  /** Whether cursor is visible on canvas */
  visible: boolean;
  /** Event type at this position */
  eventType: 'click';
  /** Mouse button if click */
  button?: string;
  /** Whether this position was interpolated (always false now) */
  isInterpolated: boolean;
  /** Fade progress for animation (0 = just clicked, 1 = faded) */
  fadeProgress?: number;
}

/**
 * Frame state returned by getFrameState()
 */
export interface FrameState {
  /** Current playback time in ms */
  timeMs: number;
  /** Click position (or null if no click near this time) */
  cursor: TransformedCursorPosition | null;
}

/**
 * Default cursor configuration
 */
export const DEFAULT_CURSOR_CONFIG: CursorConfig = {
  size: 1.0,
  style: 'default',
  showClickAnimations: true,
  clickAnimationScale: 1.2,
  clickDisplayDuration: 500,
  showMotionBlur: true,
  motionBlurStrength: 0.7,
};

/**
 * Default zoom configuration (no zoom)
 */
export const DEFAULT_ZOOM_CONFIG: ZoomConfig = {
  level: 1.0,
  focalX: 0,
  focalY: 0,
};
