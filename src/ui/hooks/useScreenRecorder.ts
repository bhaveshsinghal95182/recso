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

import type { DesktopSource, RecorderState } from '@/types';

interface UseScreenRecorderOptions {
  /** Chunk interval in ms (default: 1000) */
  timeslice?: number;
  /** Video frame rate (default: 30) */
  frameRate?: number;
  /** Include system audio */
  audio?: boolean;
}

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
  // Ref to track recording ID across async closures (e.g. track.onended)
  const recordingIdRef = useRef<string | null>(null);
  // Guard against double-stop (e.g. track ends + user clicks stop)
  const isStoppingRef = useRef(false);

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

  // Internal stop helper — used by both stopRecording() and the track.onended handler
  const stopRecordingInternal = useCallback(async () => {
    // Guard against double-stop
    if (isStoppingRef.current) {
      console.log('[Recorder] Stop already in progress, skipping');
      return { success: true };
    }
    isStoppingRef.current = true;

    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        // Request final data chunk before stopping
        mediaRecorderRef.current.requestData();
        mediaRecorderRef.current.stop();
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      const recId = recordingIdRef.current;
      if (recId) {
        recordingIdRef.current = null;
        const result = await window.electron.recorder.stop(recId);
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
    } finally {
      isStoppingRef.current = false;
    }
  }, []);

  // Start recording
  const startRecording = useCallback(
    async (
      sourceId: string,
      outputDir: string,
      fileName: string,
      videoBitrate: number = 8000000,
      mimeType: string = 'video/mp4;codecs=avc1',
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

        // Determine extension based on mimeType
        let extension: 'mp4' | 'webm' = 'webm';
        if (mimeType.includes('mp4')) {
          extension = 'mp4';
        }

        console.log(`[Recorder] Starting with mimeType: ${mimeType}, extension: ${extension}`);

        // Start recording in main process
        const result = await window.electron.recorder.start({
          sourceId,
          outputDir,
          fileName,
          fileExtension: extension,
        });

        if (!result.success || !result.recordingId) {
          throw new Error(result.error || 'Failed to start recording');
        }

        const recordingId = result.recordingId;
        recordingIdRef.current = recordingId;

        // Create MediaRecorder
        const mediaRecorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: videoBitrate,
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

        // Listen for the video track ending (e.g. user clicks "Stop Sharing")
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
          videoTrack.onended = () => {
            console.log(
              '[Recorder] Video track ended (user clicked "Stop Sharing"), auto-stopping recording',
            );
            stopRecordingInternal();
          };
        }

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
    [audio, frameRate, timeslice, stopRecordingInternal],
  );

  // Stop recording (public API — delegates to internal helper)
  const stopRecording = useCallback(async () => {
    return stopRecordingInternal();
  }, [stopRecordingInternal]);

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
