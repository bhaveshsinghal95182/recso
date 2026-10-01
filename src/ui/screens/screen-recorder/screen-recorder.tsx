import { useCallback, useEffect, useRef, useState } from 'react';

import { formats } from '@/constants';
import type { NativeCaptureDevice } from '@/types';

import {
  type RecorderUiSettings,
  useAutomationRecorderSettings,
} from '../../hooks/useAutomationRecorderSettings.ts';
import { useScreenRecorder } from '../../hooks/useScreenRecorder.ts';
import { CapturePreviewStage } from './capture-preview-stage';
import { FloatingRecorderToolbar } from './floating-recorder-toolbar';

interface ScreenRecorderBodyProps {
  onOpenEditor?: (recordingId: string) => void;
}

export function ScreenRecorderBody({ onOpenEditor }: ScreenRecorderBodyProps) {
  const {
    sources,
    state,
    error,
    refreshSources,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    isRecording,
    isPaused,
    isStopping,
  } = useScreenRecorder();

  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [fileName, setFileName] = useState('');
  const [videoBitrate, setVideoBitrate] = useState(5000000);
  const [format] = useState<string>(formats[0].value);
  const [isStarting, setIsStarting] = useState(false);
  const [isLoading, setIsLoading] = useState(sources.length === 0);
  /** Linux: the system's screen picker is open. */
  const [isPickingSource, setIsPickingSource] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  /** Linux, GNOME and KDE: how to let auto zoom see clicks, when it can't. */
  const [clickAccessHint, setClickAccessHint] = useState<string | null>(null);

  const [recordMic, setRecordMic] = useState(false);
  const [recordCamera, setRecordCamera] = useState(false);
  const [recordSystemAudio, setRecordSystemAudio] = useState(true);
  const [cameraDeviceId, setCameraDeviceId] = useState<string | null>(null);
  const [cameraSource, setCameraSource] = useState<'local' | 'phone'>('local');
  const [cameras, setCameras] = useState<NativeCaptureDevice[]>([]);
  const [cameraPreviewError, setCameraPreviewError] = useState<string | null>(null);
  /**
   * Microphones as WASAPI sees them, which is what native capture opens.
   */
  const [nativeMicrophones, setNativeMicrophones] = useState<NativeCaptureDevice[]>([]);
  const [nativeMicDeviceId, setNativeMicDeviceId] = useState<string | null>(null);

  // While the Automation API is on, follow its settings and report the user's.
  const applyAutomationSettings = useCallback((settings: Partial<RecorderUiSettings>) => {
    if (settings.outputDir !== undefined) setOutputDir(settings.outputDir);
    if (settings.recordSystemAudio !== undefined) setRecordSystemAudio(settings.recordSystemAudio);
    if (settings.recordMic !== undefined) setRecordMic(settings.recordMic);
    if (settings.nativeMicDeviceId !== undefined) setNativeMicDeviceId(settings.nativeMicDeviceId);
    if (settings.recordCamera !== undefined) setRecordCamera(settings.recordCamera);
    if (settings.cameraDeviceId !== undefined) setCameraDeviceId(settings.cameraDeviceId);
  }, []);
  const reportSetting = useAutomationRecorderSettings(applyAutomationSettings);
  const changeOutputDir = (value: string) => {
    setOutputDir(value);
    reportSetting('outputDir', value);
  };
  const changeRecordSystemAudio = (value: boolean) => {
    setRecordSystemAudio(value);
    reportSetting('recordSystemAudio', value);
  };
  const changeRecordMic = (value: boolean) => {
    setRecordMic(value);
    reportSetting('recordMic', value);
  };
  const changeNativeMicDeviceId = (value: string | null) => {
    setNativeMicDeviceId(value);
    reportSetting('nativeMicDeviceId', value ?? '');
  };
  const changeRecordCamera = (value: boolean) => {
    setRecordCamera(value);
    reportSetting('recordCamera', value);
  };
  const changeCameraDeviceId = (value: string | null) => {
    setCameraDeviceId(value);
    reportSetting('cameraDeviceId', value ?? '');
  };

  // A recording stopped elsewhere (over the API) still needs a fresh name here.
  const previousStatusRef = useRef(state.status);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = state.status;
    if (state.status === 'idle' && previous !== 'idle') {
      setFileName(`recording_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
    }
  }, [state.status]);

  useEffect(() => {
    const loadDefaults = async () => {
      const defaultDir = await window.electron.recorder.getDefaultOutputDir();
      // Unless the Automation API already set one.
      setOutputDir((current) => current || defaultDir);
      setFileName(`recording_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);

      try {
        const [nativeCameras, nativeMics] = await Promise.all([
          window.electron.recorder.listWebcamDevices(),
          window.electron.recorder.listAudioCaptureDevices(),
        ]);
        setCameras(nativeCameras);
        setCameraDeviceId(
          (current) => current ?? nativeCameras.find((device) => device.isDefault)?.id ?? null,
        );
        setNativeMicrophones(nativeMics);
        setNativeMicDeviceId(
          (current) => current ?? nativeMics.find((device) => device.isDefault)?.id ?? null,
        );
      } catch (err) {
        console.error('Failed to list native recording devices:', err);
      }
    };

    void loadDefaults();
  }, []);

  useEffect(() => {
    if (sources.length > 0) {
      setIsLoading(false);
    }
  }, [sources]);

  useEffect(() => {
    const shouldOwnSetupPreview =
      recordCamera &&
      cameraSource === 'local' &&
      Boolean(cameraDeviceId) &&
      !isStarting &&
      !isRecording &&
      !isPaused &&
      !isStopping;

    if (!shouldOwnSetupPreview) {
      if (!recordCamera || cameraSource !== 'local' || !cameraDeviceId) {
        setCameraPreviewError(
          recordCamera && cameraSource === 'local' ? 'No native webcam is available.' : null,
        );
        void window.electron.recorder.stopWebcamPreview().catch(console.warn);
      }
      return;
    }

    let cancelled = false;
    setCameraPreviewError(null);
    void window.electron.recorder
      .startWebcamPreview(cameraDeviceId ?? undefined)
      .then((result) => {
        if (!cancelled && !result.success) {
          setCameraPreviewError(result.error ?? 'Native webcam preview could not start.');
        }
      })
      .catch(() => {
        if (!cancelled) setCameraPreviewError('Native webcam preview could not start.');
      });

    return () => {
      cancelled = true;
      void window.electron.recorder.stopWebcamPreview().catch(console.warn);
    };
  }, [cameraDeviceId, cameraSource, isPaused, isRecording, isStarting, isStopping, recordCamera]);

  useEffect(() => {
    if (sources.length === 0) return;

    const selectedSourceStillExists = sources.some((source) => source.id === selectedSourceId);
    if (selectedSourceId && selectedSourceStillExists) return;

    const defaultSource =
      sources.find((source) => source.isScreen && source.isPrimary) ??
      sources.find((source) => source.isScreen) ??
      sources[0];

    setSelectedSourceId(defaultSource.id);
  }, [selectedSourceId, sources]);

  useEffect(() => {
    let cancelled = false;
    void window.electron.recorder
      .getClickAccessHint?.()
      .then((hint) => {
        if (!cancelled) setClickAccessHint(hint);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Linux: a source picked but not recorded holds a screen-share session open;
  // end it when the recorder goes away.
  useEffect(() => {
    return () => {
      void window.electron.recorder.releasePortalSource?.().catch(console.warn);
    };
  }, []);

  /**
   * Linux: open the system's screen and window picker now, so the stage shows
   * what will be recorded. Closing the picker keeps whatever was there.
   */
  const pickPortalSource = async () => {
    if (isPickingSource) return;
    setIsPickingSource(true);
    setPickError(null);
    try {
      const result = await window.electron.recorder.pickPortalSource();
      if (result.ok) {
        await refreshSources();
        setSelectedSourceId(result.source.id);
      } else if (!result.cancelled) {
        setPickError(result.error ?? 'The screen picker could not open.');
      }
    } catch (err) {
      setPickError(err instanceof Error ? err.message : 'The screen picker could not open.');
    } finally {
      setIsPickingSource(false);
    }
  };

  const handleSourceSelect = (id: string) => {
    setSelectedSourceId(id);
    if (sources.find((source) => source.id === id)?.portal) void pickPortalSource();
  };

  const handleRefreshSources = async () => {
    setIsLoading(true);
    await refreshSources();
    setIsLoading(false);
  };

  const handleStart = async () => {
    if (!selectedSourceId || !outputDir || !fileName) return;

    setIsStarting(true);
    const result = await startRecording(
      selectedSourceId,
      outputDir,
      fileName,
      videoBitrate,
      format,
      formats.find((recordingFormat) => recordingFormat.value === format)?.extension,
      recordCamera,
      recordMic,
      cameraDeviceId || undefined,
      undefined,
      recordSystemAudio,
      undefined,
      cameraSource,
      nativeMicDeviceId || undefined,
    );
    setIsStarting(false);

    if (!result.success) {
      console.error('Failed to start:', result.error);
    }
  };

  const handleStop = async () => {
    const recordingId = state.recordingId;
    const result = await stopRecording();

    if (result.success && recordingId && onOpenEditor) {
      onOpenEditor(recordingId);
      return;
    }

    setFileName(`recording_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
    await handleRefreshSources();
    setSelectedSourceId(null);
  };

  const selectedSource = sources.find((source) => source.id === selectedSourceId);

  return (
    <div className="recorder-screen animate-in fade-in duration-300">
      {(error || pickError) && <div className="recorder-error-banner">{error ?? pickError}</div>}
      {!error && !pickError && clickAccessHint && !isRecording && (
        <div className="recorder-error-banner">{clickAccessHint}</div>
      )}

      <CapturePreviewStage
        selectedSource={selectedSource}
        isLoading={isLoading}
        isRecording={isRecording}
        isPaused={isPaused}
        isStopping={isStopping}
        recordCamera={recordCamera}
        cameraDeviceId={cameraDeviceId}
        cameraDeviceLabel={
          cameras.find((device) => device.id === cameraDeviceId)?.label ?? cameras[0]?.label ?? null
        }
        cameraSource={cameraSource}
        cameraPreviewError={cameraPreviewError}
        onRefresh={handleRefreshSources}
        isPickingSource={isPickingSource}
        onPickPortalSource={() => void pickPortalSource()}
      />

      <FloatingRecorderToolbar
        isStopping={isStopping}
        sources={sources}
        selectedSourceId={selectedSourceId}
        selectedSource={selectedSource}
        isLoading={isLoading}
        isRecording={isRecording}
        isPaused={isPaused}
        isStarting={isStarting}
        duration={state.duration}
        bytesWritten={state.bytesWritten}
        outputDir={outputDir}
        fileName={fileName}
        videoBitrate={videoBitrate}
        recordMic={recordMic}
        recordCamera={recordCamera}
        recordSystemAudio={recordSystemAudio}
        cameraDeviceId={cameraDeviceId}
        nativeMicrophones={nativeMicrophones}
        nativeMicDeviceId={nativeMicDeviceId}
        onNativeMicDeviceChange={changeNativeMicDeviceId}
        cameras={cameras}
        onSourceSelect={handleSourceSelect}
        onRefreshSources={refreshSources}
        setIsLoading={setIsLoading}
        onOutputDirChange={changeOutputDir}
        onFileNameChange={setFileName}
        onVideoBitrateChange={setVideoBitrate}
        onRecordMicChange={changeRecordMic}
        onRecordCameraChange={changeRecordCamera}
        onRecordSystemAudioChange={changeRecordSystemAudio}
        onCameraDeviceChange={changeCameraDeviceId}
        cameraSource={cameraSource}
        onCameraSourceChange={setCameraSource}
        onStart={handleStart}
        onStop={handleStop}
        onPause={pauseRecording}
        onResume={resumeRecording}
      />
    </div>
  );
}
