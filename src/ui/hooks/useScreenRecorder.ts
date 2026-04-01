/**
 * useScreenRecorder — modified for multi-stream recording:
 * - Manages screen, camera, and microphone capture.
 * - Uses StreamTarget to stream video chunks to main process for crash-safe disk writes.
 * - Embeds microphone audio into the screen (and optionally camera) video directly.
 */

import type {
  MediaStreamAudioTrackSource as MediaStreamAudioTrackSourceType,
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

  // References to active mediabunny pipelines and streams
  const pipelinesRef = useRef<{
    outputs: OutputType[];
    videoSources: MediaStreamVideoTrackSourceType[];
    audioSources: MediaStreamAudioTrackSourceType[];
    streamTargets: StreamTargetType[];
    mediaStreams: MediaStream[];
  }>({
    outputs: [],
    videoSources: [],
    audioSources: [],
    streamTargets: [],
    mediaStreams: [],
  });

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
    const delayedRefresh = window.setTimeout(() => {
      refreshSources();
    }, 1200);

    return () => {
      window.clearTimeout(delayedRefresh);
      unsubscribe();
      // Cleanup on unmount
      pipelinesRef.current.mediaStreams.forEach((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      });
    };
  }, [refreshSources]);

  // Internal stop helper
  const stopRecordingInternal = useCallback(async () => {
    // Guard against double-stop
    if (isStoppingRef.current) {
      return { success: true };
    }
    isStoppingRef.current = true;

    try {
      const pipelines = pipelinesRef.current;

      // Finalize the mediabunny outputs
      await Promise.all(
        pipelines.outputs.map(async (output) => {
          if (output.state === 'started') {
            try {
              await output.finalize();
            } catch (err) {
              console.warn('[Recorder] output.finalize error:', err);
            }
          }
        }),
      );

      // Stop media stream tracks
      pipelines.mediaStreams.forEach((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      });

      // Clean up refs
      pipelinesRef.current = {
        outputs: [],
        videoSources: [],
        audioSources: [],
        streamTargets: [],
        mediaStreams: [],
      };

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

  /**
   * Start recording
   */
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
    ) => {
      try {
        setError(null);

        // Dynamically import mediabunny
        const {
          MediaStreamVideoTrackSource,
          MediaStreamAudioTrackSource,
          Output,
          StreamTarget,
          Mp4OutputFormat,
          MkvOutputFormat,
        } = await import('mediabunny');

        const extension: 'mp4' | 'mkv' = fileExtension || 'mp4';

        // Start recording in main process to create temp files
        const result = await window.electron.recorder.start({
          sourceId,
          outputDir,
          fileName,
          fileExtension: extension,
          recordCamera,
          recordMic,
        });

        if (!result.success || !result.recordingId) {
          throw new Error(result.error || 'Failed to start recording');
        }

        const recordingId = result.recordingId;
        recordingIdRef.current = recordingId;

        const pipelines = pipelinesRef.current;
        const newOutputs: OutputType[] = [];

        // 1. Acquire Streams
        const mediaStreams: MediaStream[] = [];

        // Screen Stream
        const screenStream = await navigator.mediaDevices.getUserMedia({
          audio: audio ? ({ mandatory: { chromeMediaSource: 'desktop' } } as any) : false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxFrameRate: frameRate,
            },
          } as any,
        });
        mediaStreams.push(screenStream);

        let micStream: MediaStream | null = null;
        let cameraStream: MediaStream | null = null;

        if (recordMic) {
          try {
            micStream = await navigator.mediaDevices.getUserMedia({
              audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
            });
            mediaStreams.push(micStream);
          } catch (err) {
            console.warn('[Recorder] Failed to get microphone stream:', err);
          }
        }

        if (recordCamera) {
          try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
              video: cameraDeviceId
                ? { deviceId: { exact: cameraDeviceId }, width: 1280, height: 720 }
                : { width: 1280, height: 720 },
            });
            mediaStreams.push(cameraStream);
          } catch (err) {
            console.warn('[Recorder] Failed to get camera stream:', err);
          }
        }

        pipelines.mediaStreams = mediaStreams;

        // 2. Setup Screen Pipeline (always)
        const screenWritable = new WritableStream<{ data: Uint8Array; position: number }>({
          async write(chunk) {
            const data = chunk.data;
            const exactChunk =
              data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
                ? (data.buffer as ArrayBuffer)
                : data.slice().buffer;
            await window.electron.recorder.writeChunk(
              recordingId,
              'screen',
              chunk.position,
              exactChunk,
            );
          },
        });

        const screenTarget = new StreamTarget(screenWritable, {
          chunked: true,
          chunkSize: 2 ** 20,
        });
        pipelines.streamTargets.push(screenTarget);

        const screenFormat =
          extension === 'mkv'
            ? new MkvOutputFormat()
            : new Mp4OutputFormat({ fastStart: 'in-memory' });

        const screenOutput = new Output({ format: screenFormat, target: screenTarget });
        newOutputs.push(screenOutput);

        const screenVideoTrack = screenStream.getVideoTracks()[0];
        const screenVidSource = new MediaStreamVideoTrackSource(screenVideoTrack, {
          codec: extension === 'mkv' ? 'vp9' : 'avc',
          bitrate: videoBitrate,
        });
        screenVidSource.errorPromise.catch((err) => {
          console.error('[Recorder] Screen video error:', err);
          stopRecordingInternal();
        });
        pipelines.videoSources.push(screenVidSource);
        screenOutput.addVideoTrack(screenVidSource, { frameRate });

        if (micStream) {
          const micTrack = micStream.getAudioTracks()[0];
          const micAudioSource1 = new MediaStreamAudioTrackSource(micTrack, {
            codec: 'aac',
            bitrate: 128000,
          });
          micAudioSource1.errorPromise.catch((err) =>
            console.error('[Recorder] Screen mic error:', err),
          );
          pipelines.audioSources.push(micAudioSource1);
          screenOutput.addAudioTrack(micAudioSource1);
        }

        // Listen for user stopping screen
        screenVideoTrack.onended = () => {
          console.log('[Recorder] Screen track ended, auto-stopping');
          stopRecordingInternal();
        };

        // 3. Setup Camera Pipeline (if enabled)
        let cameraOutput: OutputType | null = null;
        if (cameraStream) {
          const cameraWritable = new WritableStream<{ data: Uint8Array; position: number }>({
            async write(chunk) {
              const data = chunk.data;
              const exactChunk =
                data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
                  ? (data.buffer as ArrayBuffer)
                  : data.slice().buffer;
              await window.electron.recorder.writeChunk(
                recordingId,
                'camera',
                chunk.position,
                exactChunk,
              );
            },
          });

          const cameraTarget = new StreamTarget(cameraWritable, {
            chunked: true,
            chunkSize: 2 ** 20,
          });
          pipelines.streamTargets.push(cameraTarget);

          const camFormat =
            extension === 'mkv'
              ? new MkvOutputFormat()
              : new Mp4OutputFormat({ fastStart: 'in-memory' });

          cameraOutput = new Output({ format: camFormat, target: cameraTarget });
          newOutputs.push(cameraOutput);

          const camVideoTrack = cameraStream.getVideoTracks()[0];
          const camVidSource = new MediaStreamVideoTrackSource(camVideoTrack, {
            codec: extension === 'mkv' ? 'vp9' : 'avc',
            bitrate: 3000000, // 3 Mbps is enough for 720p webcam
          });
          camVidSource.errorPromise.catch((err) => {
            console.error('[Recorder] Camera video error:', err);
          });
          pipelines.videoSources.push(camVidSource);
          // Set frameRate explicitly to 30 for the camera
          cameraOutput.addVideoTrack(camVidSource, { frameRate: 30 });

          if (micStream) {
            // Need a second clone of the mic track for the second Pipeline
            const micTrack2 = micStream.getAudioTracks()[0].clone();
            const micAudioSource2 = new MediaStreamAudioTrackSource(micTrack2, {
              codec: 'aac',
              bitrate: 128000,
            });
            micAudioSource2.errorPromise.catch((err) =>
              console.error('[Recorder] Camera mic error:', err),
            );
            pipelines.audioSources.push(micAudioSource2);
            cameraOutput.addAudioTrack(micAudioSource2);
          }
        }

        pipelines.outputs = newOutputs;

        // Start both pipelines
        await Promise.all(newOutputs.map((out) => out.start()));

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

  // Stop recording
  const stopRecording = useCallback(async () => {
    return stopRecordingInternal();
  }, [stopRecordingInternal]);

  // Pause recording
  const pauseRecording = useCallback(() => {
    pipelinesRef.current.videoSources.forEach((s) => s.pause());
    pipelinesRef.current.audioSources.forEach((s) => s.pause());

    if (state.recordingId) {
      window.electron.recorder.pause(state.recordingId);
    }
  }, [state.recordingId]);

  // Resume recording
  const resumeRecording = useCallback(() => {
    pipelinesRef.current.videoSources.forEach((s) => s.resume());
    pipelinesRef.current.audioSources.forEach((s) => s.resume());

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
