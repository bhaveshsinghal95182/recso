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
  /** Cut regions to exclude from export */
  cuts: CutRegion[];
  /** Zoom regions for zoom effects during export */
  zoomRegions: ZoomRegion[];
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
};

/**
 * Default zoom configuration (no zoom)
 */
export const DEFAULT_ZOOM_CONFIG: ZoomConfig = {
  level: 1.0,
  focalX: 0,
  focalY: 0,
};
