import { create } from 'zustand';

import type { BackgroundPatternConfig } from '../../shared/patterns';
import { debounce } from '../lib/utils';
import { clampCanvasPadding } from '../screens/editor/engine/canvas-layout';
import type {
  BackgroundMode,
  CropConfig,
  CursorConfig,
  CursorRegionOverride,
  Project,
  RecordedMouseEvent,
  RemoteCameraState,
  WebcamOverlayConfig,
  ZoomConfig,
} from '../types';
import { usePlaybackStore } from './playback-store';
import { useTimelineStore } from './timeline-store';

interface ProjectState {
  project: Project | null;
  isLoading: boolean;
  error: string | null;
  mouseEvents: RecordedMouseEvent[];
  remoteCamera: RemoteCameraState;

  // Actions
  loadProject: (recordingId: string) => Promise<boolean>;
  saveProject: () => Promise<boolean>;
  closeProject: () => void;
  updateCursorConfig: (config: Partial<CursorConfig>) => Promise<void>;
  upsertCursorRegionOverride: (cursorOverride: CursorRegionOverride) => Promise<void>;
  replaceCursorRegionOverrides: (cursorOverrides: CursorRegionOverride[]) => Promise<void>;
  removeCursorRegionOverride: (regionId: string) => Promise<void>;
  updateZoomConfig: (config: Partial<ZoomConfig>) => Promise<void>;
  updateBackgroundColor: (color: string) => void;
  updateBackgroundPath: (path: string | null) => void;
  updateBackgroundPattern: (pattern: BackgroundPatternConfig | null) => void;
  updateBackgroundMode: (mode: BackgroundMode) => void;
  updateCanvasBackgroundEnabled: (enabled: boolean) => Promise<void>;
  updateCanvasPadding: (padding: number) => void;
  updateWebcamOverlay: (config: Partial<WebcamOverlayConfig>) => Promise<void>;
  updateCropConfig: (config: CropConfig | null) => Promise<void>;
  updateDuration: (durationMs: number) => Promise<void>;
  startRemoteCameraPairing: () => Promise<void>;
  cancelRemoteCameraPairing: () => void;
  setRemoteCameraState: (state: RemoteCameraState) => void;

  // Setters for syncing from other stores (if needed) or internal updates
  setProject: (project: Project | null) => void;
}

const DEFAULT_REMOTE_CAMERA_STATE: RemoteCameraState = {
  status: 'idle',
};

function resolvePairingOrigin(): string {
  if (typeof window === 'undefined') {
    return 'http://localhost:5123';
  }

  const origin = window.location.origin;
  if (!origin || origin === 'null' || origin.startsWith('file:')) {
    return 'http://localhost:5123';
  }

  return origin;
}

function createSessionToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

function createSessionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function buildPairingUrl(origin: string, sessionId: string, token: string): string {
  const normalizedOrigin = origin.replace(/\/$/, '');
  return `${normalizedOrigin}/remote-camera/pair?session=${sessionId}&token=${token}`;
}

// Debounced IPC call for background color updates
const debouncedUpdateBackgroundColor = debounce(async (color: string) => {
  try {
    await window.electron.background.updateColor(color);
  } catch (err) {
    console.error('[ProjectStore] updateBackgroundColor error:', err);
  }
}, 300);

// Padding is dragged on a slider — render from local state, persist once it settles.
const debouncedUpdateCanvasPadding = debounce(async (padding: number) => {
  try {
    await window.electron.editor.updateCanvasPadding(padding);
  } catch (err) {
    console.error('[ProjectStore] updateCanvasPadding error:', err);
  }
}, 300);

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  isLoading: false,
  error: null,
  mouseEvents: [],
  remoteCamera: DEFAULT_REMOTE_CAMERA_STATE,

  loadProject: async (recordingId: string) => {
    set({ isLoading: true, error: null });
    try {
      const proj = await window.electron.editor.createProject(recordingId);
      if (!proj) {
        set({ error: 'Failed to load project', isLoading: false });
        return false;
      }

      // Load mouse events
      let events: RecordedMouseEvent[] = [];
      try {
        const loadedEvents = await window.electron.editor.getMouseEvents();
        events = loadedEvents || [];
      } catch (err) {
        console.error('[ProjectStore] Failed to load mouse events:', err);
      }

      set({
        project: proj,
        mouseEvents: events,
        isLoading: false,
      });

      // Sync with TimelineStore
      useTimelineStore.getState().setCuts(proj.cuts || []);
      useTimelineStore.getState().setZoomRegionsBySource({
        screen: proj.zoomRegionsBySource?.screen || proj.zoomRegions || [],
        webcam: proj.zoomRegionsBySource?.webcam || [],
      });

      // Sync with PlaybackStore
      usePlaybackStore.getState().setDuration(proj.timeline.duration || 0);

      return true;
    } catch (err) {
      console.error('[ProjectStore] loadProject error:', err);
      set({
        error: err instanceof Error ? err.message : 'Unknown error',
        isLoading: false,
      });
      return false;
    }
  },

  saveProject: async () => {
    const { project } = get();
    if (!project) return false;
    try {
      return await window.electron.editor.saveProject();
    } catch (err) {
      console.error('[ProjectStore] saveProject error:', err);
      return false;
    }
  },

  closeProject: () => {
    set({
      project: null,
      mouseEvents: [],
      error: null,
      isLoading: false,
      remoteCamera: DEFAULT_REMOTE_CAMERA_STATE,
    });
    window.electron.editor.closeProject();

    // Reset other stores
    useTimelineStore.getState().reset();
    usePlaybackStore.getState().reset();
  },

  updateCursorConfig: async (config: Partial<CursorConfig>) => {
    const { project } = get();
    if (!project) return;
    try {
      const updated = await window.electron.editor.updateCursorConfig(config);
      if (updated) {
        set((state) => ({
          project: state.project ? { ...state.project, cursorConfig: updated } : null,
        }));
      }
    } catch (err) {
      console.error('[ProjectStore] updateCursorConfig error:', err);
    }
  },

  upsertCursorRegionOverride: async (cursorOverride: CursorRegionOverride) => {
    const { project } = get();
    if (!project) return;

    try {
      const updated = await window.electron.editor.updateCursorRegionOverride(cursorOverride);
      set((state) => ({
        project: state.project
          ? {
              ...state.project,
              cursorRegionOverrides: updated,
            }
          : null,
      }));
    } catch (err) {
      console.error('[ProjectStore] upsertCursorRegionOverride error:', err);
    }
  },

  replaceCursorRegionOverrides: async (cursorOverrides: CursorRegionOverride[]) => {
    const { project } = get();
    if (!project) return;

    try {
      const updated = await window.electron.editor.replaceCursorRegionOverrides(cursorOverrides);
      set((state) => ({
        project: state.project
          ? {
              ...state.project,
              cursorRegionOverrides: updated,
            }
          : null,
      }));
    } catch (err) {
      console.error('[ProjectStore] replaceCursorRegionOverrides error:', err);
    }
  },

  removeCursorRegionOverride: async (regionId: string) => {
    const { project } = get();
    if (!project) return;

    try {
      const updated = await window.electron.editor.removeCursorRegionOverride(regionId);
      set((state) => ({
        project: state.project
          ? {
              ...state.project,
              cursorRegionOverrides: updated,
            }
          : null,
      }));
    } catch (err) {
      console.error('[ProjectStore] removeCursorRegionOverride error:', err);
    }
  },

  updateZoomConfig: async (config: Partial<ZoomConfig>) => {
    const { project } = get();
    if (!project) return;
    try {
      const updated = await window.electron.editor.updateZoomConfig(config);
      if (updated) {
        set((state) => ({
          project: state.project ? { ...state.project, zoomConfig: updated } : null,
        }));
      }
    } catch (err) {
      console.error('[ProjectStore] updateZoomConfig error:', err);
    }
  },

  updateBackgroundColor: (color: string) => {
    const { project } = get();
    if (!project) return;

    // Optimistic update
    set((state) => ({
      project: state.project ? { ...state.project, backgroundColor: color } : null,
    }));

    debouncedUpdateBackgroundColor(color);
  },

  updateBackgroundPath: (path: string | null) => {
    const { project } = get();
    if (!project) return;

    // Optimistic update
    set((state) => ({
      project: state.project
        ? { ...state.project, backgroundPath: path === null ? undefined : path }
        : null,
    }));

    window.electron.background.updatePath(path).catch((err) => {
      console.warn('[ProjectStore] updateBackgroundPath error:', err);
    });
  },

  updateBackgroundPattern: (pattern: BackgroundPatternConfig | null) => {
    const { project } = get();
    if (!project) return;

    // Optimistic update
    set((state) => ({
      project: state.project
        ? {
            ...state.project,
            backgroundPattern: pattern,
          }
        : null,
    }));

    window.electron.background.updatePattern(pattern).catch((err) => {
      console.error('[ProjectStore] updateBackgroundPattern error:', err);
    });
  },

  updateBackgroundMode: (mode: BackgroundMode) => {
    const { project } = get();
    if (!project) return;

    set((state) => ({
      project: state.project ? { ...state.project, backgroundMode: mode } : null,
    }));

    window.electron.background.updateMode(mode).catch((err) => {
      console.error('[ProjectStore] updateBackgroundMode error:', err);
    });
  },

  updateCanvasBackgroundEnabled: async (enabled: boolean) => {
    const { project } = get();
    if (!project) return;

    const previousEnabled = project.canvasBackgroundEnabled !== false;

    try {
      // Optimistic update
      set((state) => ({
        project: state.project
          ? {
              ...state.project,
              canvasBackgroundEnabled: enabled,
            }
          : null,
      }));

      const result = await window.electron.background.updateCanvasBackgroundEnabled(enabled);
      if (!result.success) {
        throw new Error('Canvas background update was rejected');
      }

      set((state) => ({
        project: state.project
          ? {
              ...state.project,
              canvasBackgroundEnabled: result.enabled,
            }
          : null,
      }));
    } catch (err) {
      set((state) => ({
        project: state.project
          ? {
              ...state.project,
              canvasBackgroundEnabled: previousEnabled,
            }
          : null,
      }));
      console.error('[ProjectStore] updateCanvasBackgroundEnabled error:', err);
    }
  },

  updateCanvasPadding: (padding: number) => {
    const { project } = get();
    if (!project) return;

    const next = clampCanvasPadding(padding);

    // Optimistic update — the preview and export read this straight from the project.
    set((state) => ({
      project: state.project ? { ...state.project, canvasPadding: next } : null,
    }));

    debouncedUpdateCanvasPadding(next);
  },

  updateWebcamOverlay: async (config: Partial<WebcamOverlayConfig>) => {
    const { project } = get();
    if (!project) return;

    try {
      const updated = await window.electron.editor.updateWebcamOverlay(config);
      if (updated === undefined) {
        return;
      }

      set((state) => ({
        project: state.project
          ? {
              ...state.project,
              webcamOverlay: updated,
            }
          : null,
      }));
    } catch (err) {
      console.error('[ProjectStore] updateWebcamOverlay error:', err);
    }
  },

  updateCropConfig: async (config: CropConfig | null) => {
    const { project } = get();
    if (!project) return;

    // Optimistic update
    set((state) => ({
      project: state.project
        ? {
            ...state.project,
            cropConfig: config,
          }
        : null,
    }));

    try {
      await window.electron.editor.updateCropConfig(config);
    } catch (err) {
      console.error('[ProjectStore] updateCropConfig error:', err);
    }
  },

  updateDuration: async (durationMs: number) => {
    const { project } = get();
    if (!project) return;

    // Check against current project duration
    if (Math.abs(project.timeline.duration - durationMs) < 100) return;

    try {
      set((state) => ({
        project: state.project
          ? {
              ...state.project,
              timeline: { ...state.project.timeline, duration: durationMs },
            }
          : null,
      }));

      await window.electron.editor.updateProjectDuration(durationMs);

      // Sync with PlaybackStore
      usePlaybackStore.getState().setDuration(durationMs);
    } catch (err) {
      console.error('[ProjectStore] updateDuration error:', err);
    }
  },

  startRemoteCameraPairing: async () => {
    const origin = resolvePairingOrigin();
    const sessionId = createSessionId();
    const token = createSessionToken();
    const pairingUrl = buildPairingUrl(origin, sessionId, token);
    const expiresAt = Date.now() + 2 * 60 * 1000;

    set({
      remoteCamera: {
        status: 'pairing',
        pairingUrl,
        expiresAt,
      },
    });
  },

  cancelRemoteCameraPairing: () => {
    set({ remoteCamera: DEFAULT_REMOTE_CAMERA_STATE });
  },

  setRemoteCameraState: (state: RemoteCameraState) => {
    set({ remoteCamera: state });
  },

  setProject: (project) => set({ project }),
}));
