/**
 * useScreenRecorder
 *
 * Hybrid recording flow:
 * - Native velocity capture for screen/window (driven by Electron recorder service)
 * - Auxiliary streams (camera / mic / desktop-audio) written through Electron via mediabunny
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
  const isStoppingRef = useRef(false);

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

  const frameRateRef = useRef(frameRate);
  const audioRef = useRef(audio);

  useEffect(() => {
    frameRateRef.current = frameRate;
    audioRef.current = audio;
  }, [frameRate, audio]);

  const resetPipelines = useCallback(() => {
    pipelinesRef.current = {
      outputs: [],
      videoSources: [],
      audioSources: [],
      streamTargets: [],
      mediaStreams: [],
    };
  }, []);

  const stopAuxPipelines = useCallback(async () => {
    const pipelines = pipelinesRef.current;

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

    pipelines.mediaStreams.forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });

    resetPipelines();
  }, [resetPipelines]);

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
      pipelinesRef.current.mediaStreams.forEach((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      });
      resetPipelines();
    };
  }, [refreshSources, resetPipelines]);

  const stopRecordingInternal = useCallback(async () => {
    if (isStoppingRef.current) {
      return { success: true };
    }

    isStoppingRef.current = true;

    try {
      await stopAuxPipelines();

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
      return { success: false, error: message };
    } finally {
      isStoppingRef.current = false;
    }
  }, [stopAuxPipelines]);

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
      nativeCaptureMode?: 'legacy' | 'native-singular-clock',
      targetFps: 30 | 60 = 60,
      nativeWebcamDeviceId?: string,
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
          nativeCaptureMode,
          targetFps,
          nativeWebcamDeviceId,
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
        const nativeWebcamHandled = Boolean(startResult.nativeWebcamHandled);
        const shouldRecordCameraSidecar = recordCamera && !nativeWebcamHandled;
        const shouldRecordStandaloneMic = recordMic && (!recordCamera || nativeWebcamHandled);

        // If no auxiliary tracks are enabled, native recording is enough.
        if (!shouldRecordCameraSidecar && !shouldRecordStandaloneMic && !recordSystemAudio) {
          setState({
            status: 'recording',
            recordingId,
            duration: 0,
            bytesWritten: 0,
          });

          return { success: true, recordingId };
        }

        const {
          MediaStreamVideoTrackSource,
          MediaStreamAudioTrackSource,
          Output,
          StreamTarget,
          Mp4OutputFormat,
        } = await import('mediabunny');

        const pipelines = pipelinesRef.current;
        const mediaStreams: MediaStream[] = [];
        const newOutputs: OutputType[] = [];

        const createTarget = (streamId: string) => {
          const writable = new WritableStream<{ data: Uint8Array; position: number }>({
            async write(chunk) {
              const data = chunk.data;
              const exactChunk =
                data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
                  ? (data.buffer as ArrayBuffer)
                  : data.slice().buffer;
              await window.electron.recorder.writeChunk(
                recordingId!,
                streamId,
                chunk.position,
                exactChunk,
              );
            },
          });

          return new StreamTarget(writable, {
            chunked: true,
            chunkSize: 2 ** 20,
          });
        };

        const outputFormat = new Mp4OutputFormat({ fastStart: 'in-memory' });

        const resolveDesktopAudioSourceId = (): string | null => {
          if (sourceId.startsWith('screen:')) {
            return sourceId;
          }

          if (sourceId.startsWith('velocity-window:') || sourceId.startsWith('fallback-window:')) {
            const primaryScreen = sources.find((s) => s.isScreen && s.isPrimary);
            if (primaryScreen?.id) {
              return primaryScreen.id;
            }

            const anyScreen = sources.find((s) => s.isScreen);
            return anyScreen?.id ?? null;
          }

          return null;
        };

        const openDesktopAudioCapture = async (
          desktopAudioSourceId: string,
        ): Promise<MediaStream> => {
          const audioConstraints = {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: desktopAudioSourceId,
            },
          } as unknown as MediaTrackConstraints;

          const videoProfiles: MediaTrackConstraints[] = [
            {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: desktopAudioSourceId,
                maxFrameRate: 5,
                maxWidth: 1280,
                maxHeight: 720,
              },
            } as unknown as MediaTrackConstraints,
            {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: desktopAudioSourceId,
              },
            } as unknown as MediaTrackConstraints,
          ];

          let lastError: unknown = null;

          for (let profileIndex = 0; profileIndex < videoProfiles.length; profileIndex += 1) {
            try {
              return await navigator.mediaDevices.getUserMedia({
                audio: audioConstraints,
                video: videoProfiles[profileIndex],
              });
            } catch (err) {
              lastError = err;
              console.warn(
                `[Recorder] Desktop audio capture profile ${profileIndex + 1}/${videoProfiles.length} failed.`,
                err,
              );
            }
          }

          throw lastError instanceof Error
            ? lastError
            : new Error('Failed to open desktop capture stream.');
        };

        let micStream: MediaStream | null = null;
        if (recordMic) {
          try {
            micStream = await navigator.mediaDevices.getUserMedia({
              audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
            });
            mediaStreams.push(micStream);
          } catch (err) {
            console.warn('[Recorder] Failed to open microphone stream:', err);
          }
        }

        if (shouldRecordCameraSidecar) {
          try {
            const cameraStream = await navigator.mediaDevices.getUserMedia({
              video: cameraDeviceId
                ? { deviceId: { exact: cameraDeviceId }, width: 1280, height: 720 }
                : { width: 1280, height: 720 },
            });
            mediaStreams.push(cameraStream);

            const cameraTarget = createTarget('camera');
            pipelines.streamTargets.push(cameraTarget);

            const cameraOutput = new Output({ format: outputFormat, target: cameraTarget });
            newOutputs.push(cameraOutput);

            const cameraVideoTrack = cameraStream.getVideoTracks()[0];
            const cameraVideoSource = new MediaStreamVideoTrackSource(cameraVideoTrack, {
              codec: 'avc',
              bitrate: 3_000_000,
            });
            pipelines.videoSources.push(cameraVideoSource);
            cameraOutput.addVideoTrack(cameraVideoSource, { frameRate: frameRateRef.current });

            if (micStream) {
              const micTrackForCamera = micStream.getAudioTracks()[0]?.clone();
              if (micTrackForCamera) {
                const micForCameraSource = new MediaStreamAudioTrackSource(micTrackForCamera, {
                  codec: 'aac',
                  bitrate: 128_000,
                });
                pipelines.audioSources.push(micForCameraSource);
                cameraOutput.addAudioTrack(micForCameraSource);
              }
            }
          } catch (err) {
            console.warn('[Recorder] Failed to open camera stream:', err);
          }
        }

        if (shouldRecordStandaloneMic && micStream) {
          const micTarget = createTarget('mic');
          pipelines.streamTargets.push(micTarget);

          const micOutput = new Output({ format: outputFormat, target: micTarget });
          newOutputs.push(micOutput);

          const micTrack = micStream.getAudioTracks()[0];
          if (micTrack) {
            const micSource = new MediaStreamAudioTrackSource(micTrack, {
              codec: 'aac',
              bitrate: 128_000,
            });
            pipelines.audioSources.push(micSource);
            micOutput.addAudioTrack(micSource);
          }
        }

        if (recordSystemAudio) {
          try {
            const desktopAudioSourceId = resolveDesktopAudioSourceId();

            if (!desktopAudioSourceId) {
              throw new Error('No desktop source available for system audio capture.');
            }

            // Request desktop video + audio together for Chromium desktop constraints compatibility,
            // then discard the temporary video track and keep only audio.
            const desktopCaptureStream = await openDesktopAudioCapture(desktopAudioSourceId);

            desktopCaptureStream.getVideoTracks().forEach((track) => track.stop());

            const capturedDesktopAudioTrack = desktopCaptureStream.getAudioTracks()[0];
            if (!capturedDesktopAudioTrack) {
              throw new Error('Desktop capture returned no audio track.');
            }

            const systemAudioStream = new MediaStream([capturedDesktopAudioTrack]);
            mediaStreams.push(systemAudioStream);

            const desktopAudioTarget = createTarget('desktop-audio');
            pipelines.streamTargets.push(desktopAudioTarget);

            const desktopAudioOutput = new Output({
              format: outputFormat,
              target: desktopAudioTarget,
            });
            newOutputs.push(desktopAudioOutput);

            const systemAudioTrack = systemAudioStream.getAudioTracks()[0];
            if (systemAudioTrack) {
              const desktopAudioSource = new MediaStreamAudioTrackSource(systemAudioTrack, {
                codec: 'aac',
                bitrate: 160_000,
              });
              pipelines.audioSources.push(desktopAudioSource);
              desktopAudioOutput.addAudioTrack(desktopAudioSource);
            }
          } catch (err) {
            console.warn('[Recorder] Failed to open desktop audio stream:', err);
          }
        }

        pipelines.mediaStreams = mediaStreams;
        pipelines.outputs = newOutputs;

        await Promise.all(newOutputs.map((output) => output.start()));

        setState({
          status: 'recording',
          recordingId,
          duration: 0,
          bytesWritten: 0,
        });

        return { success: true, recordingId };
      } catch (err) {
        await stopAuxPipelines();

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
    [sources, stopAuxPipelines],
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
  };
}
