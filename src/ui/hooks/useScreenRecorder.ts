/**
 * useScreenRecorder — quick overview:
 * - Manages screen capture in the renderer process using mediabunny.
 * - Uses StreamTarget to stream video chunks (with byte offsets) to main process for crash-safe disk writes.
 * - Provides start/stop/pause/resume controls and real-time state.
 *
 * Usage:
 *   const { sources, startRecording, stopRecording, state } = useScreenRecorder();
 */

import type {
  MediaStreamVideoTrackSource as MediaStreamVideoTrackSourceType,
  Output as OutputType,
  StreamTarget as StreamTargetType,
} from 'mediabunny';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopSource, RecorderState } from '@/types';

interface UseScreenRecorderOptions {
  /** Video frame rate (default: 30) */
  frameRate?: number;
  /** Include system audio */
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

  const outputRef = useRef<OutputType | null>(null);
  const videoSourceRef = useRef<MediaStreamVideoTrackSourceType | null>(null);
  const streamTargetRef = useRef<StreamTargetType | null>(null);
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
    // Follow-up refresh helps when Windows/AppX source discovery arrives late.
    const delayedRefresh = window.setTimeout(() => {
      refreshSources();
    }, 1200);

    return () => {
      window.clearTimeout(delayedRefresh);
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
      // Finalize the mediabunny output (flushes remaining data, writes metadata)
      if (outputRef.current && outputRef.current.state === 'started') {
        try {
          await outputRef.current.finalize();
          console.log('[Recorder] mediabunny output finalized');
        } catch (err) {
          console.warn('[Recorder] output.finalize error:', err);
        }
      }

      // Stop media stream tracks
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      // Clean up refs
      outputRef.current = null;
      videoSourceRef.current = null;
      streamTargetRef.current = null;

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
      _mimeType: string = 'video/mp4;codecs=avc1',
      fileExtension?: 'mp4' | 'mkv',
    ) => {
      try {
        setError(null);

        // Dynamically import mediabunny (it's an ESM module)
        const {
          MediaStreamVideoTrackSource,
          Output,
          StreamTarget,
          Mp4OutputFormat,
          MkvOutputFormat,
        } = await import('mediabunny');

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

        // Determine extension: prefer passed arg, default to mp4
        const extension: 'mp4' | 'mkv' = fileExtension || 'mp4';

        console.log(`[Recorder] Starting with mediabunny, extension: ${extension}`);

        // Start recording in main process (creates the temp file)
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

        // Create a WritableStream that pipes chunks to the backend via IPC
        const writable = new WritableStream<{ data: Uint8Array; position: number }>({
          async write(chunk) {
            const data = chunk.data;
            // Ensure we only send the exact chunk window, not a larger backing buffer.
            const exactChunk =
              data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
                ? (data.buffer as ArrayBuffer)
                : data.slice().buffer;

            // Send data + byte offset to main process for random-access file write
            await window.electron.recorder.writeChunk(recordingId, chunk.position, exactChunk);
          },
        });

        // Create mediabunny StreamTarget with chunked mode for performance
        const streamTarget = new StreamTarget(writable, {
          chunked: true,
          chunkSize: 2 ** 20, // 1 MiB chunks
        });
        streamTargetRef.current = streamTarget;

        // Choose the correct output format based on extension
        const outputFormat =
          extension === 'mkv'
            ? new MkvOutputFormat()
            : new Mp4OutputFormat({ fastStart: 'in-memory' });

        // Create mediabunny Output
        const output = new Output({
          format: outputFormat,
          target: streamTarget,
        });
        outputRef.current = output;

        // Create video source from the media stream track
        const videoTrack = stream.getVideoTracks()[0];
        const videoTrackSource = new MediaStreamVideoTrackSource(videoTrack, {
          codec: extension === 'mkv' ? 'vp9' : 'avc',
          bitrate: videoBitrate,
        });
        videoSourceRef.current = videoTrackSource;

        // Handle encoding errors
        videoTrackSource.errorPromise.catch((err: Error) => {
          console.error('[Recorder] MediaStreamVideoTrackSource error:', err);
          setError(`Recording error: ${err.message}`);
          stopRecordingInternal();
        });

        // Add video track to output
        output.addVideoTrack(videoTrackSource, { frameRate });

        // Listen for the video track ending (e.g. user clicks "Stop Sharing")
        videoTrack.onended = () => {
          console.log(
            '[Recorder] Video track ended (user clicked "Stop Sharing"), auto-stopping recording',
          );
          stopRecordingInternal();
        };

        // Start the mediabunny output pipeline
        await output.start();

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
    [audio, frameRate, stopRecordingInternal],
  );

  // Stop recording (public API — delegates to internal helper)
  const stopRecording = useCallback(async () => {
    return stopRecordingInternal();
  }, [stopRecordingInternal]);

  // Pause recording
  const pauseRecording = useCallback(() => {
    if (videoSourceRef.current) {
      videoSourceRef.current.pause();
    }
    if (state.recordingId) {
      window.electron.recorder.pause(state.recordingId);
    }
  }, [state.recordingId]);

  // Resume recording
  const resumeRecording = useCallback(() => {
    if (videoSourceRef.current) {
      videoSourceRef.current.resume();
    }
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
