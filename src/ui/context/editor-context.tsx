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
  FrameState,
  Project,
  TransformedCursorPosition,
  ZoomConfig,
} from '../types';

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

  // Refs for animation frame
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);

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

  const value: EditorContextValue = {
    project,
    isLoading,
    error,
    isPlaying,
    currentTime,
    duration,
    frameState,
    loadProject,
    saveProject,
    closeProject,
    play,
    pause,
    seek,
    updateCursorConfig,
    updateZoomConfig,
    updateDuration,
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
