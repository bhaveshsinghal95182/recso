/**
 * useScreenRecorder — quick overview:
 * - Manages screen capture in the renderer process using MediaRecorder API.
 * - Streams video chunks to main process for crash-safe disk writes.
 * - Provides start/stop/pause/resume controls and real-time state.
 *
 * Usage:
 *   const { sources, startRecording, stopRecording, state } = useScreenRecorder();
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopSource, RecorderState, UseScreenRecorderOptions } from '@/types';

export function useScreenRecorder(options: UseScreenRecorderOptions = {}) {
  const { timeslice = 1000, frameRate = 30, audio = false } = options;

  const [sources, setSources] = useState<DesktopSource[]>([]);
  const [state, setState] = useState<RecorderState>({
    status: 'idle',
    recordingId: null,
    duration: 0,
    bytesWritten: 0,
  });
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Fetch available sources
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
      // Cleanup on unmount
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, [refreshSources]);

  // Start recording
  const startRecording = useCallback(
    async (
      sourceId: string,
      outputDir: string,
      fileName: string,
      recordingOptions?: { videoBitrate?: number },
    ) => {
      try {
        setError(null);

        // Get media stream from the source

        const constraints: any = {
          audio: audio
            ? {
                mandatory: {
                  chromeMediaSource: 'desktop',
                },
              }
            : false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxFrameRate: frameRate,
            },
          },
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;

        // Start recording in main process
        const result = await window.electron.recorder.start({
          sourceId,
          outputDir,
          fileName,
          options: recordingOptions, // Pass options to backend for metadata
        });

        if (!result.success || !result.recordingId) {
          throw new Error(result.error || 'Failed to start recording');
        }

        const recordingId = result.recordingId;

        // Create MediaRecorder
        const mediaRecorder = new MediaRecorder(stream, {
          mimeType: 'video/webm;codecs=vp9',
          videoBitsPerSecond: recordingOptions?.videoBitrate || 5000000, // Default 5 Mbps
        });

        mediaRecorderRef.current = mediaRecorder;

        // Stream chunks to main process
        mediaRecorder.ondataavailable = async (event) => {
          if (event.data.size > 0) {
            const arrayBuffer = await event.data.arrayBuffer();
            await window.electron.recorder.appendChunk(recordingId, arrayBuffer);
          }
        };

        mediaRecorder.onerror = () => {
          setError('Recording error occurred');
        };

        // Start with timeslice for chunked recording
        mediaRecorder.start(timeslice);

        setState({
          status: 'recording',
          recordingId,
          duration: 0,
          bytesWritten: 0,
        });

        return { success: true, recordingId };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to start recording';
        setError(message);
        return { success: false, error: message };
      }
    },
    [audio, frameRate, timeslice],
  );

  // Stop recording
  const stopRecording = useCallback(async () => {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

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
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.pause();
      if (state.recordingId) {
        window.electron.recorder.pause(state.recordingId);
      }
    }
  }, [state.recordingId]);

  // Resume recording
  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
      mediaRecorderRef.current.resume();
      if (state.recordingId) {
        window.electron.recorder.resume(state.recordingId);
      }
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
