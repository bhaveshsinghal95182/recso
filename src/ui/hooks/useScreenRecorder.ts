/**
 * useScreenRecorder
 *
 * Starts and stops a native recording. That is the whole of it.
 *
 * There used to be a second pipeline here: `getUserMedia` and `getDisplayMedia`
 * feeding mediabunny `Output`s that streamed camera, microphone and desktop
 * audio back through IPC as sidecar files, to be muxed or aligned afterwards.
 * It is gone. Every one of those is captured natively now, against the
 * picture's own clock, so the sidecars existed only to be reconciled with the
 * recording they were supposed to be part of -- and the reconciliation was a
 * guess. Recording already required the native addon, so nothing was falling
 * back to the browser anyway; the code just made it look like something might.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopSource, RecorderState, StopRecordingResult } from '@/types';

interface UseScreenRecorderOptions {
  frameRate?: number;
  audio?: boolean;
}

export function useScreenRecorder(options: UseScreenRecorderOptions = {}) {
  const { frameRate = 30, audio = false } = options;

  const [sources, setSources] = useState<DesktopSource[]>([]);
  const [state, setState] = useState<RecorderState>({
    status: 'idle',
    recordingId: null,
    duration: 0,
    bytesWritten: 0,
  });
  const [error, setError] = useState<string | null>(null);

  const recordingIdRef = useRef<string | null>(null);
  // The stop pass in flight, if any. Held as a promise rather than a boolean so
  // a second stop trigger joins the real work instead of being told it already
  // succeeded — the editor opens off this result, and a premature success sends
  // it at a recording that is still being written.
  const stopPassRef = useRef<Promise<StopRecordingResult> | null>(null);

  const frameRateRef = useRef(frameRate);
  const audioRef = useRef(audio);

  useEffect(() => {
    frameRateRef.current = frameRate;
    audioRef.current = audio;
  }, [frameRate, audio]);

  const refreshSources = useCallback(async () => {
    try {
      const nextSources = await window.electron.recorder.getSources();
      setSources(nextSources);
      return nextSources;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get sources');
      return [];
    }
  }, []);

  useEffect(() => {
    const unsubscribe = window.electron.recorder.onStateChange((newState) => {
      // A poll queued before the stop can still land mid-finalize; taking it
      // would flip the UI back to 'recording' and make the stop look ignored.
      if (stopPassRef.current) {
        return;
      }

      setState({
        status: newState.state.toLowerCase() as 'idle' | 'recording' | 'paused',
        recordingId: newState.recordingId,
        duration: newState.duration,
        bytesWritten: newState.bytesWritten,
      });

      recordingIdRef.current = newState.recordingId;
    });

    refreshSources();
    const delayedRefresh = window.setTimeout(() => {
      refreshSources();
    }, 1200);

    return () => {
      window.clearTimeout(delayedRefresh);
      unsubscribe();
    };
  }, [refreshSources]);

  const stopRecordingInternal = useCallback((): Promise<StopRecordingResult> => {
    const inFlight = stopPassRef.current;
    if (inFlight) {
      return inFlight;
    }

    const pass = (async (): Promise<StopRecordingResult> => {
      try {
        // Announce the finalize before any of the slow work starts, so the
        // button reacts to the very first click.
        setState((current) => ({ ...current, status: 'stopping' }));

        const recordingId = recordingIdRef.current;
        if (!recordingId) {
          return { success: false, error: 'No active recording' };
        }

        const result = await window.electron.recorder.stop(recordingId);
        recordingIdRef.current = null;

        setState({
          status: 'idle',
          recordingId: null,
          duration: 0,
          bytesWritten: 0,
        });

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to stop recording';
        setError(message);
        setState((current) => ({ ...current, status: 'idle' }));
        return { success: false, error: message };
      }
    })();

    stopPassRef.current = pass;
    void pass.finally(() => {
      stopPassRef.current = null;
    });

    return pass;
  }, []);

  const startRecording = useCallback(
    async (
      sourceId: string,
      outputDir: string,
      fileName: string,
      videoBitrate: number = 8000000,
      _mimeType: string = 'video/mp4;codecs=avc1',
      fileExtension?: 'mp4' | 'mkv',
      recordCamera: boolean = false,
      recordMic: boolean = false,
      cameraDeviceId?: string,
      micDeviceId?: string,
      recordSystemAudio: boolean = false,
      targetFps: 30 | 60 = 60,
      nativeWebcamDeviceId?: string,
      cameraSource: 'local' | 'phone' = 'local',
      nativeMicDeviceId?: string,
    ) => {
      let recordingId: string | null = null;

      try {
        setError(null);

        if (fileExtension === 'mkv') {
          console.warn(
            '[Recorder] MKV recording is temporarily disabled for native capture; using MP4 to avoid corruption.',
          );
        }

        const extension: 'mp4' = 'mp4';

        const startResult = await window.electron.recorder.start({
          sourceId,
          outputDir,
          fileName,
          fileExtension: extension,
          recordCamera,
          recordMic,
          recordSystemAudio,
          cameraDeviceId,
          micDeviceId,
          targetFps,
          nativeWebcamDeviceId,
          cameraSource,
          nativeMicDeviceId,
          options: {
            videoBitrate,
            audioBitrate: audioRef.current ? 128000 : 0,
          },
        });

        if (!startResult.success || !startResult.recordingId) {
          throw new Error(startResult.error || 'Failed to start recording');
        }

        recordingId = startResult.recordingId;
        recordingIdRef.current = recordingId;

        setState({
          status: 'recording',
          recordingId,
          duration: 0,
          bytesWritten: 0,
        });

        return { success: true, recordingId };
      } catch (err) {
        if (recordingId) {
          try {
            await window.electron.recorder.stop(recordingId);
          } catch {
            // ignored
          }
          recordingIdRef.current = null;
        }

        const message = err instanceof Error ? err.message : 'Failed to start recording';
        setError(message);
        return { success: false, error: message };
      }
    },
    [sources],
  );

  const stopRecording = useCallback(async () => {
    return stopRecordingInternal();
  }, [stopRecordingInternal]);

  const pauseRecording = useCallback(() => {
    if (state.recordingId) {
      window.electron.recorder.pause(state.recordingId);
    }
  }, [state.recordingId]);

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
    isStopping: state.status === 'stopping',
  };
}
