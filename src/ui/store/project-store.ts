import { create } from 'zustand';

import type { BackgroundPatternConfig } from '../../shared/patterns';
import { debounce } from '../lib/utils';
import type { CursorConfig, Project, RecordedMouseEvent, ZoomConfig } from '../types';
import { usePlaybackStore } from './playback-store';
import { useTimelineStore } from './timeline-store';

interface ProjectState {
  project: Project | null;
  isLoading: boolean;
  error: string | null;
  mouseEvents: RecordedMouseEvent[];

  // Actions
  loadProject: (recordingId: string) => Promise<boolean>;
  saveProject: () => Promise<boolean>;
  closeProject: () => void;
  updateCursorConfig: (config: Partial<CursorConfig>) => Promise<void>;
  updateZoomConfig: (config: Partial<ZoomConfig>) => Promise<void>;
  updateBackgroundColor: (color: string) => void;
  updateBackgroundPattern: (pattern: BackgroundPatternConfig | null) => void;
  updateDuration: (durationMs: number) => Promise<void>;

  // Setters for syncing from other stores (if needed) or internal updates
  setProject: (project: Project | null) => void;
}

// Debounced IPC call for background color updates
const debouncedUpdateBackgroundColor = debounce(async (color: string) => {
  try {
    await window.electron.editor.updateBackgroundColor(color);
  } catch (err) {
    console.error('[ProjectStore] updateBackgroundColor error:', err);
  }
}, 300);

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  isLoading: false,
  error: null,
  mouseEvents: [],

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
      useTimelineStore.getState().setZoomRegions(proj.zoomRegions || []);

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

    window.electron.editor.updateBackgroundPattern(pattern).catch((err) => {
      console.error('[ProjectStore] updateBackgroundPattern error:', err);
    });
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

  setProject: (project) => set({ project }),
}));
