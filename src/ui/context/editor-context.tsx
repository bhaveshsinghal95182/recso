/**
 * EditorContext — Central state management for the video editor.
 *
 * Provides:
 * - Active project state
 * - Playback controls (play/pause/seek)
 * - Cursor and zoom configuration
 * - Integration with electron.editor IPC
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { findClosestEventInWindow } from '../lib/utils';
import type {
  CursorConfig,
  CutRegion,
  FrameState,
  Project,
  TransformedCursorPosition,
  ZoomConfig,
  ZoomRegion,
} from '../types';

// Tabs for the properties panel
export type PropertiesTab = 'general' | 'zoom' | 'export';

// Mouse event interface (matching backend)
interface MouseEvent {
  id?: number;
  recordingId: string;
  timestampMs: number;
  x: number;
  y: number;
  eventType: 'click' | 'mousemove';
  button?: 'left' | 'right' | 'middle';
}

// EditorActions and EditorState replaced by split interfaces
// Breakdown of state into two contexts to prevent re-renders
// 1. Static/Low-frequency state (Project, Cuts, Zooms, etc.)
// 2. High-frequency state (Playback, Current Time, Cursor)

// --- Context Definitions ---
const EditorStateContext = createContext<EditorStateContextValue | null>(null);
const EditorPlaybackContext = createContext<EditorPlaybackContextValue | null>(null);

// Left for backward compatibility, but effectively unused by split hooks
const EditorContext = createContext<EditorContextValue | null>(null);

// --- Interface Splits ---
interface EditorStateContextValue {
  project: Project | null;
  isLoading: boolean;
  error: string | null;
  activePropertiesTab: PropertiesTab;
  cuts: CutRegion[];
  selectedCutId: string | null;
  zoomRegions: ZoomRegion[];
  selectedZoomId: string | null;
  isEditingFocalPoint: boolean;
  mouseEvents: MouseEvent[];
  // Actions that don't depend on playback state
  loadProject: (recordingId: string) => Promise<boolean>;
  saveProject: () => Promise<boolean>;
  closeProject: () => void;
  updateCursorConfig: (config: Partial<CursorConfig>) => void;
  updateZoomConfig: (config: Partial<ZoomConfig>) => void;
  updateDuration: (durationMs: number) => void;
  updateBackgroundColor: (color: string) => void;
  setActivePropertiesTab: (tab: PropertiesTab) => void;
  addCut: (startMs: number, endMs: number) => Promise<void>;
  removeCut: (cutId: string) => Promise<void>;
  updateCut: (cut: CutRegion) => Promise<void>;
  setSelectedCut: (cutId: string | null) => void;
  addZoom: (startMs: number, endMs: number) => Promise<void>;
  removeZoom: (zoomId: string) => Promise<void>;
  updateZoom: (zoom: ZoomRegion) => Promise<void>;
  updateZoomRegions: (zooms: ZoomRegion[]) => Promise<void>;
  replaceZoomRegions: (zooms: ZoomRegion[]) => Promise<void>;
  setSelectedZoom: (zoomId: string | null) => void;
  setIsEditingFocalPoint: (isEditing: boolean) => void;
}

interface EditorPlaybackContextValue {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  frameState: FrameState | null;
  play: () => void;
  pause: () => void;
  seek: (timeMs: number) => void;
}

// Combined for legacy support
type EditorContextValue = EditorStateContextValue & EditorPlaybackContextValue;

// ... [Keep existing EditorProviderProps] ...
interface EditorProviderProps {
  children: ReactNode;
  recordingId?: string;
}

export function EditorProvider({ children, recordingId }: EditorProviderProps) {
  // ... [Keep all existing state and refs logic] ...
  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [frameState, setFrameState] = useState<FrameState | null>(null);
  const [mouseEvents, setMouseEvents] = useState<MouseEvent[]>([]);
  const [activePropertiesTab, setActivePropertiesTab] = useState<PropertiesTab>('general');
  const [cuts, setCuts] = useState<CutRegion[]>([]);
  const [selectedCutId, setSelectedCut] = useState<string | null>(null);
  const [zoomRegions, setZoomRegions] = useState<ZoomRegion[]>([]);
  const [selectedZoomId, setSelectedZoom] = useState<string | null>(null);
  const [isEditingFocalPoint, setIsEditingFocalPoint] = useState(false);

  const animationFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ... [Keep all existing effects: loadProject, getCursorAtTime, frameState sync, Playback loop] ...
  // [Re-inserting omitted effect logic for brevity, assuming tool won't delete unless I overlap]
  // Wait, I am replacing the whole file content effectively to restructure.
  // I need to be careful to re-include EVERYTHING I'm not changing.

  // Load project on mount
  useEffect(() => {
    if (recordingId) {
      loadProject(recordingId);
    }
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [recordingId]);

  const getCursorAtTime = useCallback(
    (timeMs: number): TransformedCursorPosition | null => {
      if (!mouseEvents || mouseEvents.length === 0) return null;
      const windowMs = 500;
      const nearbyClick = findClosestEventInWindow(mouseEvents, timeMs, windowMs);
      if (!nearbyClick) return null;
      const distance = Math.abs(nearbyClick.timestampMs - timeMs);
      const fadeProgress = distance / windowMs;
      return {
        x: nearbyClick.x,
        y: nearbyClick.y,
        visible: true,
        eventType: 'click',
        button: nearbyClick.button,
        isInterpolated: false,
        fadeProgress,
      };
    },
    [mouseEvents],
  );

  useEffect(() => {
    if (!project) return;
    const cursor = getCursorAtTime(currentTime);
    setFrameState({ timeMs: currentTime, cursor });
  }, [currentTime, project, getCursorAtTime]);

  useEffect(() => {
    if (!isPlaying || !project) return;
    const tick = (timestamp: number) => {
      if (lastFrameTimeRef.current === 0) lastFrameTimeRef.current = timestamp;
      const delta = timestamp - lastFrameTimeRef.current;
      lastFrameTimeRef.current = timestamp;
      setCurrentTime((prev) => {
        const next = prev + delta;
        if (next >= duration) {
          setIsPlaying(false);
          return duration;
        }
        return next;
      });
      animationFrameRef.current = requestAnimationFrame(tick);
    };
    lastFrameTimeRef.current = 0;
    animationFrameRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [isPlaying, project, duration]);

  // ... [Actions] ...
  const loadProject = useCallback(async (recId: string): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    try {
      const proj = await window.electron.editor.createProject(recId);
      if (!proj) {
        setError('Failed to load project');
        setIsLoading(false);
        return false;
      }
      setProject(proj);
      setDuration(proj.timeline.duration || 0);
      setCuts(proj.cuts || []);
      setSelectedCut(null);
      setZoomRegions(proj.zoomRegions || []);
      setSelectedZoom(null);
      setCurrentTime(0);
      try {
        const events = await window.electron.editor.getMouseEvents();
        setMouseEvents(events || []);
        console.log('[EditorContext] Loaded mouse events:', events?.length);
      } catch (err) {
        console.error('[EditorContext] Failed to load mouse events:', err);
        setMouseEvents([]);
      }
      setIsLoading(false);
      return true;
    } catch (err) {
      console.error('[EditorContext] loadProject error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setIsLoading(false);
      return false;
    }
  }, []);

  const saveProject = useCallback(async (): Promise<boolean> => {
    if (!project) return false;
    try {
      return await window.electron.editor.saveProject();
    } catch (err) {
      console.error('[EditorContext] saveProject error:', err);
      return false;
    }
  }, [project]);

  const closeProject = useCallback(() => {
    setIsPlaying(false);
    setProject(null);
    setCurrentTime(0);
    setDuration(0);
    setFrameState(null);
    setMouseEvents([]);
    window.electron.editor.closeProject();
  }, []);

  const play = useCallback(() => {
    if (currentTime >= duration) setCurrentTime(0);
    setIsPlaying(true);
  }, [currentTime, duration]);

  const pause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const seek = useCallback(
    (timeMs: number) => {
      setCurrentTime(Math.max(0, Math.min(timeMs, duration)));
    },
    [duration],
  );

  const updateCursorConfig = useCallback(
    async (config: Partial<CursorConfig>) => {
      if (!project) return;
      try {
        const updated = await window.electron.editor.updateCursorConfig(config);
        if (updated) setProject((prev) => (prev ? { ...prev, cursorConfig: updated } : null));
      } catch (err) {
        console.error('[EditorContext] updateCursorConfig error:', err);
      }
    },
    [project],
  );

  const updateZoomConfig = useCallback(
    async (config: Partial<ZoomConfig>) => {
      if (!project) return;
      try {
        const updated = await window.electron.editor.updateZoomConfig(config);
        if (updated) setProject((prev) => (prev ? { ...prev, zoomConfig: updated } : null));
      } catch (err) {
        console.error('[EditorContext] updateZoomConfig error:', err);
      }
    },
    [project],
  );

  const updateDuration = useCallback(
    async (durationMs: number) => {
      if (!project) return;
      if (Math.abs(duration - durationMs) < 100) return;
      try {
        setDuration(durationMs);
        await window.electron.editor.updateProjectDuration(durationMs);
        setProject((prev) =>
          prev ? { ...prev, timeline: { ...prev.timeline, duration: durationMs } } : null,
        );
      } catch (err) {
        console.error('[EditorContext] updateDuration error:', err);
      }
    },
    [project, duration],
  );

  const updateBackgroundColor = useCallback(
    (color: string) => {
      if (!project) return;
      setProject((prev) => (prev ? { ...prev, backgroundColor: color } : null));
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        try {
          await window.electron.editor.updateBackgroundColor(color);
        } catch (err) {
          console.error('[EditorContext] updateBackgroundColor error:', err);
        }
      }, 300);
    },
    [project],
  );

  const addCut = useCallback(
    async (startMs: number, endMs: number) => {
      if (!project) return;
      const newCut: CutRegion = { id: crypto.randomUUID(), startMs, endMs };
      try {
        await window.electron.editor.addCut(newCut);
        setCuts((prev) => [...prev, newCut].sort((a, b) => a.startMs - b.startMs));
        setProject((prev) =>
          prev
            ? { ...prev, cuts: [...prev.cuts, newCut].sort((a, b) => a.startMs - b.startMs) }
            : null,
        );
      } catch (err) {
        console.error('[EditorContext] addCut error:', err);
      }
    },
    [project],
  );

  const removeCut = useCallback(
    async (cutId: string) => {
      if (!project) return;
      try {
        await window.electron.editor.removeCut(cutId);
        setCuts((prev) => prev.filter((c) => c.id !== cutId));
        setProject((prev) =>
          prev ? { ...prev, cuts: prev.cuts.filter((c) => c.id !== cutId) } : null,
        );
        if (selectedCutId === cutId) setSelectedCut(null);
      } catch (err) {
        console.error('[EditorContext] removeCut error:', err);
      }
    },
    [project, selectedCutId],
  );

  const updateCut = useCallback(
    async (cut: CutRegion) => {
      if (!project) return;
      try {
        await window.electron.editor.updateCut(cut);
        setCuts((prev) =>
          prev.map((c) => (c.id === cut.id ? cut : c)).sort((a, b) => a.startMs - b.startMs),
        );
        setProject((prev) =>
          prev
            ? {
                ...prev,
                cuts: prev.cuts
                  .map((c) => (c.id === cut.id ? cut : c))
                  .sort((a, b) => a.startMs - b.startMs),
              }
            : null,
        );
      } catch (err) {
        console.error('[EditorContext] updateCut error:', err);
      }
    },
    [project],
  );

  const addZoom = useCallback(
    async (startMs: number, endMs: number) => {
      if (!project) return;
      const newZoom: ZoomRegion = {
        id: crypto.randomUUID(),
        startMs,
        endMs,
        zoomLevel: 1.5,
        focalX: 0.5,
        focalY: 0.5,
        easeDurationMs: 300,
      };
      try {
        await window.electron.editor.addZoomRegion(newZoom);
        setZoomRegions((prev) => [...prev, newZoom].sort((a, b) => a.startMs - b.startMs));
        setProject((prev) =>
          prev
            ? {
                ...prev,
                zoomRegions: [...(prev.zoomRegions || []), newZoom].sort(
                  (a, b) => a.startMs - b.startMs,
                ),
              }
            : null,
        );
      } catch (err) {
        console.error('[EditorContext] addZoom error:', err);
      }
    },
    [project],
  );

  const removeZoom = useCallback(
    async (zoomId: string) => {
      if (!project) return;
      try {
        await window.electron.editor.removeZoomRegion(zoomId);
        setZoomRegions((prev) => prev.filter((z) => z.id !== zoomId));
        setProject((prev) =>
          prev
            ? { ...prev, zoomRegions: (prev.zoomRegions || []).filter((z) => z.id !== zoomId) }
            : null,
        );
        if (selectedZoomId === zoomId) setSelectedZoom(null);
      } catch (err) {
        console.error('[EditorContext] removeZoom error:', err);
      }
    },
    [project, selectedZoomId],
  );

  const updateZoom = useCallback(
    async (zoom: ZoomRegion) => {
      if (!project) return;
      setZoomRegions((prev) =>
        prev.map((z) => (z.id === zoom.id ? zoom : z)).sort((a, b) => a.startMs - b.startMs),
      );
      setProject((prev) =>
        prev
          ? {
              ...prev,
              zoomRegions: (prev.zoomRegions || [])
                .map((z) => (z.id === zoom.id ? zoom : z))
                .sort((a, b) => a.startMs - b.startMs),
            }
          : null,
      );
      if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current);
      zoomDebounceRef.current = setTimeout(async () => {
        try {
          await window.electron.editor.updateZoomRegion(zoom);
        } catch (err) {
          console.error('[EditorContext] updateZoom error:', err);
        }
      }, 300);
    },
    [project],
  );

  const updateZoomRegions = useCallback(
    async (zooms: ZoomRegion[]) => {
      if (!project) return;
      try {
        await window.electron.editor.updateZoomRegions(zooms);
        setZoomRegions((prev) => {
          const updated = prev.map((z) => zooms.find((u) => u.id === z.id) || z);
          return updated.sort((a, b) => a.startMs - b.startMs);
        });
        setProject((prev) =>
          prev
            ? {
                ...prev,
                zoomRegions: (prev.zoomRegions || [])
                  .map((z) => zooms.find((u) => u.id === z.id) || z)
                  .sort((a, b) => a.startMs - b.startMs),
              }
            : null,
        );
      } catch (err) {
        console.error('[EditorContext] updateZoomRegions error:', err);
      }
    },
    [project],
  );

  const replaceZoomRegions = useCallback(
    async (zooms: ZoomRegion[]) => {
      if (!project) return;
      try {
        const currentZooms = await window.electron.editor.getZoomRegions();
        for (const z of currentZooms) await window.electron.editor.removeZoomRegion(z.id);
        for (const z of zooms) await window.electron.editor.addZoomRegion(z);
        const sorted = [...zooms].sort((a, b) => a.startMs - b.startMs);
        setZoomRegions(sorted);
        setProject((prev) => (prev ? { ...prev, zoomRegions: sorted } : null));
      } catch (err) {
        console.error('[EditorContext] replaceZoomRegions error:', err);
      }
    },
    [project],
  );

  // --- Values ---
  const stateValue: EditorStateContextValue = {
    project,
    isLoading,
    error,
    activePropertiesTab,
    cuts,
    selectedCutId,
    zoomRegions,
    selectedZoomId,
    isEditingFocalPoint,
    mouseEvents,
    loadProject,
    saveProject,
    closeProject,
    updateCursorConfig,
    updateZoomConfig,
    updateDuration,
    updateBackgroundColor,
    setActivePropertiesTab,
    addCut,
    removeCut,
    updateCut,
    setSelectedCut,
    addZoom,
    removeZoom,
    updateZoom,
    updateZoomRegions,
    replaceZoomRegions,
    setSelectedZoom,
    setIsEditingFocalPoint,
  };

  const playbackValue: EditorPlaybackContextValue = {
    isPlaying,
    currentTime,
    duration,
    frameState,
    play,
    pause,
    seek,
  };

  const combinedValue: EditorContextValue = {
    ...stateValue,
    ...playbackValue,
  };

  return (
    <EditorStateContext.Provider value={stateValue}>
      <EditorPlaybackContext.Provider value={playbackValue}>
        <EditorContext.Provider value={combinedValue}>{children}</EditorContext.Provider>
      </EditorPlaybackContext.Provider>
    </EditorStateContext.Provider>
  );
}

/**
 * Hook to access editor STATE (low-frequency updates).
 * Use this for UI components (Properties, Export, Settings).
 */
export function useEditorState(): EditorStateContextValue {
  const context = useContext(EditorStateContext);
  if (!context) throw new Error('useEditorState must be used within an EditorProvider');
  return context;
}

/**
 * Hook to access editor PLAYBACK (high-frequency updates).
 * Use this for Timeline, Preview, and Scrubbers.
 */
export function useEditorPlayback(): EditorPlaybackContextValue {
  const context = useContext(EditorPlaybackContext);
  if (!context) throw new Error('useEditorPlayback must be used within an EditorProvider');
  return context;
}

/**
 * Legacy hook accessing BOTH contexts.
 * @deprecated Prefer useEditorState or useEditorPlayback for better performance.
 */
export function useEditor(): EditorContextValue {
  const context = useContext(EditorContext);
  if (!context) throw new Error('useEditor must be used within an EditorProvider');
  return context;
}

/**
 * Hook to get current cursor position.
 * @note This causes high-frequency re-renders. Use with caution.
 */
export function useCursorPosition(): TransformedCursorPosition | null {
  const { frameState } = useEditorPlayback();
  return frameState?.cursor ?? null;
}
