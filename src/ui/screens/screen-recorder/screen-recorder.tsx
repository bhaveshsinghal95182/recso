import { AppWindow, Monitor } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Card } from '@/components/ui/card';
import { formats } from '@/constants';

import { useScreenRecorder } from '../../hooks/useScreenRecorder.ts';
import { CameraPreview } from './camera-preview';
import Header from './header';
import { RecordingControls } from './recording-controls';
import { SettingsPanel } from './settings-panel';
import { SourceSelector } from './source-selector';

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
  } = useScreenRecorder();

  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [fileName, setFileName] = useState('');
  const [videoBitrate, setVideoBitrate] = useState(5000000);
  const [format, setFormat] = useState<string>(formats[0].value);
  const [isStarting, setIsStarting] = useState(false);

  // Add-on Devices State
  const [recordMic, setRecordMic] = useState(false);
  const [recordCamera, setRecordCamera] = useState(false);
  const [recordSystemAudio, setRecordSystemAudio] = useState(true);
  const [cameraDeviceId, setCameraDeviceId] = useState<string | null>(null);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);

  // 'selection' = source grid, 'ready' = settings & record button
  const [view, setView] = useState<'selection' | 'ready'>('selection');

  // Initialize defaults
  useEffect(() => {
    const loadDefaults = async () => {
      const defaultDir = await window.electron.recorder.getDefaultOutputDir();
      setOutputDir(defaultDir);
      setFileName(`recording_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setCameras(devices.filter((d) => d.kind === 'videoinput'));
        setMicrophones(devices.filter((d) => d.kind === 'audioinput'));
      } catch (err) {
        console.error('Failed to enumerate devices:', err);
      }
    };
    loadDefaults();
  }, []);

  // Handle source selection -> transition to ready view
  const handleSourceSelect = (id: string) => {
    setSelectedSourceId(id);
    setView('ready');
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
      formats.find((f) => f.value === format)?.extension,
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
    // Capture recording ID before stopping (state will be cleared)
    const recordingId = state.recordingId;

    const result = await stopRecording();

    if (result.success && recordingId && onOpenEditor) {
      // Navigate to editor with the recording
      onOpenEditor(recordingId);
    } else {
      // Reset state for next recording (only if not navigating away)
      setFileName(`recording_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
      refreshSources();
      setView('selection');
      setSelectedSourceId(null);
    }
  };

  const selectedSource = sources.find((s) => s.id === selectedSourceId);

  return (
    <div className="flex flex-col h-full bg-background animate-in fade-in duration-300">
      <div className="flex-1 flex flex-col p-6 gap-6 overflow-y-auto">
        {/* Header Text */}
        <Header
          isRecording={isRecording}
          view={view}
          selectedSource={selectedSource}
          isPaused={isPaused}
        />

        {/* Error Banner */}
        {error && (
          <div className="bg-destructive/15 text-destructive px-4 py-3 rounded-lg text-sm text-center font-medium border border-destructive/20 max-w-lg mx-auto w-full">
            {error}
          </div>
        )}

        {/* Main Content Area */}
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center">
          {/* Active Recording State */}
          {isRecording || isPaused ? (
            <div className="w-full max-w-2xl">
              <RecordingControls
                status={state.status}
                duration={state.duration}
                bytesWritten={state.bytesWritten}
                onStart={handleStart}
                onStop={handleStop}
                onPause={pauseRecording}
                onResume={resumeRecording}
              />
            </div>
          ) : view === 'selection' ? (
            /* View 1: Source Selection */
            <div className="w-full h-full flex flex-col items-center">
              <div className="w-full max-w-5xl flex-1 min-h-0 border rounded-2xl bg-card/50 shadow-sm backdrop-blur-sm overflow-hidden flex flex-col">
                <SourceSelector
                  sources={sources}
                  selectedSourceId={selectedSourceId}
                  onSelect={handleSourceSelect}
                  isLoading={sources.length === 0}
                  onRefresh={refreshSources}
                />
              </div>
            </div>
          ) : (
            /* View 2: Ready / Settings */
            <div className="w-full max-w-5xl flex flex-col md:flex-row gap-8 items-center justify-center h-full">
              {/* Left: Monitor Info */}
              <div className="flex-1 w-full flex flex-col items-center justify-center">
                <Card className="w-full max-w-xl aspect-video overflow-hidden border-2 border-brand/20 relative group bg-card/50 shadow-[0_0_30px_rgba(16,185,129,0.05)]">
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_20%,var(--color-brand-dark)_150%)] opacity-20 pointer-events-none" />
                  <div className="w-full h-full flex flex-col items-center justify-center p-3 relative z-10">
                    {selectedSource?.thumbnailDataUrl ? (
                      <div className="relative w-full h-full flex items-center justify-center">
                        <img
                          src={selectedSource.thumbnailDataUrl}
                          alt={selectedSource.name}
                          className="max-w-full max-h-full object-contain rounded-md shadow-2xl ring-1 ring-white/10"
                        />
                        <CameraPreview
                          deviceId={cameraDeviceId}
                          isActive={recordCamera}
                          className="absolute bottom-4 right-4 w-24 h-24 md:w-32 md:h-32 xl:w-40 xl:h-40 z-20 transition-all duration-300"
                        />
                      </div>
                    ) : (
                      <div className="p-6 rounded-2xl bg-brand/10">
                        {selectedSource?.isScreen ? (
                          <Monitor size={64} className="text-brand" />
                        ) : (
                          <AppWindow size={64} className="text-brand" />
                        )}
                      </div>
                    )}
                    {!selectedSource?.thumbnailDataUrl && (
                      <div className="text-center space-y-2 mt-4">
                        <h3 className="text-xl font-semibold text-foreground">
                          {selectedSource?.name}
                        </h3>
                        {selectedSource?.width && selectedSource?.height && (
                          <p className="text-muted-foreground">
                            {selectedSource.width} × {selectedSource.height}
                          </p>
                        )}
                        {selectedSource?.isPrimary && (
                          <span className="inline-block px-3 py-1 text-xs font-semibold uppercase bg-brand/20 text-brand-light rounded-full mt-2">
                            Primary Display
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
              </div>

              {/* Right: Controls & Settings */}
              <div className="w-full md:w-80 flex flex-col gap-6 shrink-0">
                <Card className="p-4 bg-card/80 backdrop-blur-sm">
                  <SettingsPanel
                    outputDir={outputDir}
                    fileName={fileName}
                    videoBitrate={videoBitrate}
                    format={format}
                    recordMic={recordMic}
                    recordCamera={recordCamera}
                    recordSystemAudio={recordSystemAudio}
                    cameraDeviceId={cameraDeviceId}
                    micDeviceId={micDeviceId}
                    cameras={cameras}
                    microphones={microphones}
                    onOutputDirChange={setOutputDir}
                    onFileNameChange={setFileName}
                    onVideoBitrateChange={setVideoBitrate}
                    onFormatChange={setFormat}
                    onRecordMicChange={setRecordMic}
                    onRecordCameraChange={setRecordCamera}
                    onRecordSystemAudioChange={setRecordSystemAudio}
                    onCameraDeviceChange={setCameraDeviceId}
                    onMicDeviceChange={setMicDeviceId}
                  />
                </Card>

                <div className="mt-4">
                  <RecordingControls
                    status="idle"
                    duration={0}
                    bytesWritten={0}
                    onStart={handleStart}
                    onStop={handleStop}
                    onPause={pauseRecording}
                    onResume={resumeRecording}
                    isStarting={isStarting}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
