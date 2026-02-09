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

// Editor state interface
interface EditorState {
  project: Project | null;
  isLoading: boolean;
  error: string | null;
  // Playback
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  // Frame state (cursor position at current time)
  frameState: FrameState | null;
  // Active properties panel tab
  activePropertiesTab: PropertiesTab;
  // Cut regions
  cuts: CutRegion[];
  selectedCutId: string | null;
  // Zoom regions
  zoomRegions: ZoomRegion[];
  selectedZoomId: string | null;
  // Focal point editing mode
  isEditingFocalPoint: boolean;
}

// Editor actions interface
interface EditorActions {
  // Project management
  loadProject: (recordingId: string) => Promise<boolean>;
  saveProject: () => Promise<boolean>;
  closeProject: () => void;
  // Playback
  play: () => void;
  pause: () => void;
  seek: (timeMs: number) => void;
  // Configuration
  updateCursorConfig: (config: Partial<CursorConfig>) => void;
  updateZoomConfig: (config: Partial<ZoomConfig>) => void;
  updateDuration: (durationMs: number) => void;
  updateBackgroundColor: (color: string) => void;
  setActivePropertiesTab: (tab: PropertiesTab) => void;
  // Cut management
  addCut: (startMs: number, endMs: number) => Promise<void>;
  removeCut: (cutId: string) => Promise<void>;
  updateCut: (cut: CutRegion) => Promise<void>;
  setSelectedCut: (cutId: string | null) => void;
  // Zoom management
  addZoom: (startMs: number, endMs: number) => Promise<void>;
  removeZoom: (zoomId: string) => Promise<void>;
  updateZoom: (zoom: ZoomRegion) => Promise<void>;
  updateZoomRegions: (zooms: ZoomRegion[]) => Promise<void>;
  replaceZoomRegions: (zooms: ZoomRegion[]) => Promise<void>;
  setSelectedZoom: (zoomId: string | null) => void;
  setIsEditingFocalPoint: (isEditing: boolean) => void;
}

type EditorContextValue = EditorState & EditorActions;

const EditorContext = createContext<EditorContextValue | null>(null);

interface EditorProviderProps {
  children: ReactNode;
  recordingId?: string;
}

export function EditorProvider({ children, recordingId }: EditorProviderProps) {
  // State
  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [frameState, setFrameState] = useState<FrameState | null>(null);

  // Active properties tab (default to 'general')
  const [activePropertiesTab, setActivePropertiesTab] = useState<PropertiesTab>('general');

  // Cut regions state
  const [cuts, setCuts] = useState<CutRegion[]>([]);
  const [selectedCutId, setSelectedCut] = useState<string | null>(null);

  // Zoom regions state
  const [zoomRegions, setZoomRegions] = useState<ZoomRegion[]>([]);
  const [selectedZoomId, setSelectedZoom] = useState<string | null>(null);

  // Focal point editing mode
  const [isEditingFocalPoint, setIsEditingFocalPoint] = useState(false);

  // Refs for animation frame
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce ref for zoom updates (to separate it from background color updates)
  const zoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load project on mount if recordingId provided
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

  // Update frame state when time changes
  useEffect(() => {
    if (!project) return;

    const updateFrameState = async () => {
      try {
        const state = await window.electron.editor.getFrameState(currentTime);
        setFrameState(state);
      } catch (err) {
        console.error('[EditorContext] Failed to get frame state:', err);
      }
    };

    updateFrameState();
  }, [currentTime, project]);

  // Playback loop
  useEffect(() => {
    if (!isPlaying || !project) return;

    const tick = (timestamp: number) => {
      if (lastFrameTimeRef.current === 0) {
        lastFrameTimeRef.current = timestamp;
      }

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
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isPlaying, project, duration]);

  // Actions
  const loadProject = useCallback(async (recId: string): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      // Try to create project (will load existing if available)
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
    window.electron.editor.closeProject();
  }, []);

  const play = useCallback(() => {
    if (currentTime >= duration) {
      setCurrentTime(0);
    }
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
        if (updated) {
          setProject((prev) => (prev ? { ...prev, cursorConfig: updated } : null));
        }
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
        if (updated) {
          setProject((prev) => (prev ? { ...prev, zoomConfig: updated } : null));
        }
      } catch (err) {
        console.error('[EditorContext] updateZoomConfig error:', err);
      }
    },
    [project],
  );

  const updateDuration = useCallback(
    async (durationMs: number) => {
      if (!project) return;

      // Only update if changed (prevents loops)
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

      // Optimistic update
      setProject((prev) => (prev ? { ...prev, backgroundColor: color } : null));

      // Debounce IPC call
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

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

  // Cut management actions
  const addCut = useCallback(
    async (startMs: number, endMs: number) => {
      if (!project) return;

      const newCut: CutRegion = {
        id: crypto.randomUUID(),
        startMs,
        endMs,
      };

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
        if (selectedCutId === cutId) {
          setSelectedCut(null);
        }
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

  // Zoom management actions
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
        if (selectedZoomId === zoomId) {
          setSelectedZoom(null);
        }
      } catch (err) {
        console.error('[EditorContext] removeZoom error:', err);
      }
    },
    [project, selectedZoomId],
  );

  const updateZoom = useCallback(
    async (zoom: ZoomRegion) => {
      if (!project) return;

      // Optimistic update
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

      // Debounce IPC call
      if (zoomDebounceRef.current) {
        clearTimeout(zoomDebounceRef.current);
      }

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
          const updated = prev.map((z) => {
            const match = zooms.find((u) => u.id === z.id);
            return match || z;
          });
          return updated.sort((a, b) => a.startMs - b.startMs);
        });
        setProject((prev) =>
          prev
            ? {
                ...prev,
                zoomRegions: (prev.zoomRegions || [])
                  .map((z) => {
                    const match = zooms.find((u) => u.id === z.id);
                    return match || z;
                  })
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

  /**
   * Completely replace all zoom regions (not a merge — used by Smart Pan)
   */
  const replaceZoomRegions = useCallback(
    async (zooms: ZoomRegion[]) => {
      if (!project) return;

      try {
        // Sync to backend
        // First remove all existing, then add all new
        const currentZooms = await window.electron.editor.getZoomRegions();
        for (const z of currentZooms) {
          await window.electron.editor.removeZoomRegion(z.id);
        }
        for (const z of zooms) {
          await window.electron.editor.addZoomRegion(z);
        }

        // Update local state
        const sorted = [...zooms].sort((a, b) => a.startMs - b.startMs);
        setZoomRegions(sorted);
        setProject((prev) => (prev ? { ...prev, zoomRegions: sorted } : null));
      } catch (err) {
        console.error('[EditorContext] replaceZoomRegions error:', err);
      }
    },
    [project],
  );

  const value: EditorContextValue = {
    project,
    isLoading,
    error,
    isPlaying,
    currentTime,
    duration,
    frameState,
    activePropertiesTab,
    cuts,
    selectedCutId,
    zoomRegions,
    selectedZoomId,
    isEditingFocalPoint,
    loadProject,
    saveProject,
    closeProject,
    play,
    pause,
    seek,
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

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

/**
 * Hook to access editor context
 */
export function useEditor(): EditorContextValue {
  const context = useContext(EditorContext);
  if (!context) {
    throw new Error('useEditor must be used within an EditorProvider');
  }
  return context;
}

/**
 * Hook to get current cursor position (convenience wrapper)
 */
export function useCursorPosition(): TransformedCursorPosition | null {
  const { frameState } = useEditor();
  return frameState?.cursor ?? null;
}
