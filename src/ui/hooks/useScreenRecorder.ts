/**
 * useScreenRecorder — quick overview:
 * - Provides screen recording controls via IPC to native Rust recorder.
 * - No MediaRecorder or getUserMedia needed - recording happens natively.
 * - Provides start/stop/pause/resume controls and real-time state.
 *
 * Usage:
 *   const { sources, startRecording, stopRecording, state } = useScreenRecorder();
 */

import { useCallback, useEffect, useState } from 'react';

import type { DesktopSource, RecorderState, RecordingOptions } from '@/types';

export function useScreenRecorder() {
  const [sources, setSources] = useState<DesktopSource[]>([]);
  const [state, setState] = useState<RecorderState>({
    status: 'idle',
    recordingId: null,
    duration: 0,
    bytesWritten: 0,
  });
  const [error, setError] = useState<string | null>(null);

  // Fetch available sources (monitors)
  const refreshSources = useCallback(async () => {
    try {
      const sources = await window.electron.recorder.getSources();
      setSources(sources);
      return sources;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get sources');
      return [];
    }
  }, []);

  // Subscribe to state updates from main process
  useEffect(() => {
    const unsubscribe = window.electron.recorder.onStateChange((newState) => {
      setState({
        status: newState.state.toLowerCase() as 'idle' | 'recording' | 'paused',
        recordingId: newState.recordingId,
        duration: newState.duration,
        bytesWritten: newState.bytesWritten,
      });
    });

    // Initial source fetch
    refreshSources();

    return () => {
      unsubscribe();
    };
  }, [refreshSources]);

  // Start recording (native - no getUserMedia needed)
  const startRecording = useCallback(
    async (
      sourceId: string,
      outputDir: string,
      fileName: string,
      recordingOptions?: RecordingOptions,
    ) => {
      try {
        setError(null);

        // Start recording in main process (native Rust recorder)
        const result = await window.electron.recorder.start({
          sourceId,
          outputDir,
          fileName,
          options: recordingOptions,
        });

        if (!result.success || !result.recordingId) {
          throw new Error(result.error || 'Failed to start recording');
        }

        setState({
          status: 'recording',
          recordingId: result.recordingId,
          duration: 0,
          bytesWritten: 0,
        });

        return { success: true, recordingId: result.recordingId };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to start recording';
        setError(message);
        return { success: false, error: message };
      }
    },
    [],
  );

  // Stop recording
  const stopRecording = useCallback(async () => {
    try {
      if (state.recordingId) {
        const result = await window.electron.recorder.stop(state.recordingId);
        setState({
          status: 'idle',
          recordingId: null,
          duration: 0,
          bytesWritten: 0,
        });
        return result;
      }

      return { success: false, error: 'No active recording' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to stop recording';
      setError(message);
      return { success: false, error: message };
    }
  }, [state.recordingId]);

  // Pause recording
  const pauseRecording = useCallback(() => {
    if (state.recordingId) {
      window.electron.recorder.pause(state.recordingId);
    }
  }, [state.recordingId]);

  // Resume recording
  const resumeRecording = useCallback(() => {
    if (state.recordingId) {
      window.electron.recorder.resume(state.recordingId);
    }
  }, [state.recordingId]);

  return {
    sources,
    refreshSources,
    state,
    error,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    isRecording: state.status === 'recording',
    isPaused: state.status === 'paused',
  };
}
