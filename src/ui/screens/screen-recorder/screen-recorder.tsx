import { useEffect, useState } from 'react';

import { formats } from '@/constants';

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

  const [recordMic, setRecordMic] = useState(false);
  const [recordCamera, setRecordCamera] = useState(false);
  const [recordSystemAudio, setRecordSystemAudio] = useState(true);
  const [cameraDeviceId, setCameraDeviceId] = useState<string | null>(null);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    const loadDefaults = async () => {
      const defaultDir = await window.electron.recorder.getDefaultOutputDir();
      setOutputDir(defaultDir);
      setFileName(`recording_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setCameras(devices.filter((device) => device.kind === 'videoinput'));
        setMicrophones(devices.filter((device) => device.kind === 'audioinput'));
      } catch (err) {
        console.error('Failed to enumerate devices:', err);
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
    if (sources.length === 0) return;

    const selectedSourceStillExists = sources.some((source) => source.id === selectedSourceId);
    if (selectedSourceId && selectedSourceStillExists) return;

    const defaultSource =
      sources.find((source) => source.isScreen && source.isPrimary) ??
      sources.find((source) => source.isScreen) ??
      sources[0];

    setSelectedSourceId(defaultSource.id);
  }, [selectedSourceId, sources]);

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
      micDeviceId || undefined,
      recordSystemAudio,
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
      {error && <div className="recorder-error-banner">{error}</div>}

      <CapturePreviewStage
        selectedSource={selectedSource}
        isLoading={isLoading}
        isRecording={isRecording}
        isPaused={isPaused}
        isStopping={isStopping}
        recordCamera={recordCamera}
        cameraDeviceId={cameraDeviceId}
        onRefresh={handleRefreshSources}
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
        micDeviceId={micDeviceId}
        cameras={cameras}
        microphones={microphones}
        onSourceSelect={setSelectedSourceId}
        onRefreshSources={refreshSources}
        setIsLoading={setIsLoading}
        onOutputDirChange={setOutputDir}
        onFileNameChange={setFileName}
        onVideoBitrateChange={setVideoBitrate}
        onRecordMicChange={setRecordMic}
        onRecordCameraChange={setRecordCamera}
        onRecordSystemAudioChange={setRecordSystemAudio}
        onCameraDeviceChange={setCameraDeviceId}
        onMicDeviceChange={setMicDeviceId}
        onStart={handleStart}
        onStop={handleStop}
        onPause={pauseRecording}
        onResume={resumeRecording}
      />
    </div>
  );
}
