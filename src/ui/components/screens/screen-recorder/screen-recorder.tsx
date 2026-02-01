import { ArrowLeft, Monitor } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useScreenRecorder } from '@/hooks/useScreenRecorder';

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
  const [isStarting, setIsStarting] = useState(false);

  // 'selection' = source grid, 'ready' = settings & record button
  const [view, setView] = useState<'selection' | 'ready'>('selection');

  // Initialize defaults
  useEffect(() => {
    const loadDefaults = async () => {
      const defaultDir = await window.electron.recorder.getDefaultOutputDir();
      setOutputDir(defaultDir);
      setFileName(`recording_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
    };
    loadDefaults();
  }, []);

  // Handle source selection -> transition to ready view
  const handleSourceSelect = (id: string) => {
    setSelectedSourceId(id);
    setView('ready');
  };

  const handleBack = () => {
    setView('selection');
    setSelectedSourceId(null);
  };

  const handleStart = async () => {
    if (!selectedSourceId || !outputDir || !fileName) return;

    setIsStarting(true);
    const result = await startRecording(selectedSourceId, outputDir, fileName);
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
        {/* Top Header Area */}
        <div className="flex items-center justify-between min-h-[40px]">
          {view === 'ready' && !isRecording && !isPaused && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBack}
              className="gap-2 -ml-2 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft size={16} />
              Back to Sources
            </Button>
          )}
          {/* Placeholder for symmetry or other controls */}
          <div />
        </div>

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
            <div className="w-full max-w-4xl flex flex-col md:flex-row gap-8 items-start justify-center h-full max-h-[500px]">
              {/* Left: Monitor Info */}
              <div className="flex-1 w-full h-full flex flex-col gap-4">
                <Card className="flex-1 overflow-hidden border-2 border-primary/20 relative group bg-card/50">
                  <div className="w-full h-full flex flex-col items-center justify-center gap-4 p-8">
                    <div className="p-6 rounded-2xl bg-primary/10">
                      <Monitor size={64} className="text-primary" />
                    </div>
                    <div className="text-center space-y-2">
                      <h3 className="text-xl font-semibold">{selectedSource?.name}</h3>
                      {selectedSource?.width && selectedSource?.height && (
                        <p className="text-muted-foreground">
                          {selectedSource.width} × {selectedSource.height}
                        </p>
                      )}
                      {selectedSource?.isPrimary && (
                        <span className="inline-block px-3 py-1 text-xs font-semibold uppercase bg-primary/20 text-primary rounded-full">
                          Primary Display
                        </span>
                      )}
                    </div>
                  </div>
                </Card>
              </div>

              {/* Right: Controls & Settings */}
              <div className="w-full md:w-80 flex flex-col gap-6 h-full justify-center">
                <Card className="p-4 bg-card/80 backdrop-blur-sm">
                  <SettingsPanel
                    outputDir={outputDir}
                    fileName={fileName}
                    videoBitrate={videoBitrate}
                    onOutputDirChange={setOutputDir}
                    onFileNameChange={setFileName}
                    onVideoBitrateChange={setVideoBitrate}
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
