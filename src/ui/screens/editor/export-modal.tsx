/**
 * Export Modal — Dialog for configuring and starting video exports.
 *
 * Features:
 * - Resolution selection (720p, 1080p, 4K, Custom)
 * - Format selection (MP4)
 * - Quality presets (Low, Medium, High, Lossless)
 * - Source-matched frame rate export
 * - Real-time progress tracking
 */

import { Dialog } from '@base-ui/react/dialog';
import confetti from 'canvas-confetti';
import { Download, FolderOpen, Loader2, Play, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useExportStore } from '@/store/export-store';
import { usePlaybackStore } from '@/store/playback-store';
import { useProjectStore } from '@/store/project-store';
import { useTimelineStore } from '@/store/timeline-store';
import type {
  ExportConfig,
  ExportFormat,
  ExportProgress,
  ExportQuality,
  ExportResolution,
} from '@/types';

import { planExport, runNativeExport } from './engine/export-pipeline';

interface ExportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ExportStep = 'configure' | 'exporting' | 'complete' | 'error';

const RESOLUTION_OPTIONS: { value: ExportResolution; label: string }[] = [
  { value: '720p', label: '720p (1280×720)' },
  { value: '1080p', label: '1080p (1920×1080)' },
  { value: '4k', label: '4K (3840×2160)' },
  { value: 'custom', label: 'Custom' },
];

const QUALITY_OPTIONS: { value: ExportQuality; label: string }[] = [
  { value: 'low', label: 'Low (smaller file)' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High (recommended)' },
  { value: 'lossless', label: 'Lossless (largest file)' },
];

/**
 * Confetti trigger component — fires confetti animation on mount
 */
function ConfettiTrigger() {
  useEffect(() => {
    // Burst of confetti from center
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 },
      gravity: 0.8,
      ticks: 200,
    });

    // Secondary burst from sides
    setTimeout(() => {
      confetti({
        particleCount: 60,
        spread: 100,
        origin: { x: 0.2, y: 0.5 },
        gravity: 0.8,
        ticks: 160,
      });
      confetti({
        particleCount: 60,
        spread: 100,
        origin: { x: 0.8, y: 0.5 },
        gravity: 0.8,
        ticks: 160,
      });
    }, 200);
  }, []);

  return null;
}

export function ExportModal({ open, onOpenChange }: ExportModalProps) {
  const { project, mouseEvents } = useProjectStore();
  const { cuts, zoomRegionsBySource } = useTimelineStore();
  const { phase, startExport, reportProgress, completeExport, failExport, setModalOpen, reset } =
    useExportStore();

  // Map export phase to modal step
  const step: ExportStep =
    phase.kind === 'idle'
      ? 'configure'
      : phase.kind === 'exporting'
        ? 'exporting'
        : phase.kind === 'complete'
          ? 'complete'
          : 'error';

  const progress = phase.kind === 'exporting' ? phase.progress : null;
  const result = phase.kind === 'complete' ? phase.result : null;
  const errorMessage = phase.kind === 'error' ? phase.message : null;

  // Export configuration state
  const [resolution, setResolution] = useState<ExportResolution>('1080p');
  const [customWidth, setCustomWidth] = useState(1920);
  const [customHeight, setCustomHeight] = useState(1080);
  const format: ExportFormat = 'mp4'; // Only MP4 is currently supported
  const [quality, setQuality] = useState<ExportQuality>('high');
  const [fileName, setFileName] = useState<string>('');
  const [outputFolder, setOutputFolder] = useState<string>('');
  const exportCancelRef = useRef<(() => void) | null>(null);

  // Sync modal open state with store
  useEffect(() => {
    setModalOpen(open);
  }, [open, setModalOpen]);

  // Track previous open state to detect open transitions
  const prevOpenRef = useRef(false);

  // Reset state and pause playback when modal first opens (closed→open transition).
  // We intentionally do NOT react to phase changes here — doing so would
  // reset the 'complete'/'error' states before the user sees them.
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !wasOpen) {
      // Only reset if not currently exporting
      if (phase.kind !== 'exporting') {
        reset();
      }
      // Pause playback to prevent high-frequency re-renders from currentTime updates
      // This fixes input lag in the modal
      const { isPlaying, pause } = usePlaybackStore.getState();
      if (isPlaying) {
        pause();
      }
    }
  }, [open, phase.kind, reset]);

  const handleExport = useCallback(async () => {
    if (!project) return;

    const config: ExportConfig = {
      resolution,
      customWidth: resolution === 'custom' ? customWidth : undefined,
      customHeight: resolution === 'custom' ? customHeight : undefined,
      format,
      quality,
      backgroundColor: project.backgroundColor || '#000000',
      outputFolder: outputFolder || undefined,
      outputFilename: fileName || undefined,
      glRenderer: 'angle', // Enable GPU acceleration
    };

    startExport();

    try {
      const outputPath = await window.electron.exporter.resolveOutputPath(config);
      if (!outputPath) {
        throw new Error('Unable to resolve export output path');
      }

      const shared = {
        // Cut edits are owned by the timeline store and are persisted
        // asynchronously; the project object can therefore still contain the
        // pre-edit snapshot when export is started.
        project: { ...project, cuts },
        config,
        screenZoomRegions: zoomRegionsBySource.screen,
        webcamZoomRegions: zoomRegionsBySource.webcam,
        mouseEvents,
        onProgress: (nextProgress: ExportProgress) => {
          reportProgress(nextProgress);
        },
        onCancelReady: (cancel: () => void) => {
          exportCancelRef.current = cancel;
        },
      };

      const plan = await planExport(shared);

      // The engine writes the file itself. Nothing comes back through the
      // renderer, so recording size is not bounded by renderer memory.
      const rendered = await runNativeExport({ ...shared, plan, outputPath });

      completeExport({
        outputPath: rendered.outputPath,
        duration: rendered.durationSeconds,
        fileSize: await window.electron.exporter.fileSize(rendered.outputPath),
      });

      // Trigger confetti
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed';

      // Cancelled during export — reset to configure, don't show error
      if (message === 'Export cancelled') {
        reset();
        return;
      }

      failExport(message);
    } finally {
      exportCancelRef.current = null;
    }
  }, [
    project,
    resolution,
    customWidth,
    customHeight,
    format,
    quality,
    fileName,
    outputFolder,
    zoomRegionsBySource,
    startExport,
    reportProgress,
    completeExport,
    failExport,
    reset,
  ]);

  const handleCancel = useCallback(async () => {
    const cancelCurrent = exportCancelRef.current;
    if (cancelCurrent) {
      cancelCurrent();
      reset();
      return;
    }
    reset();
  }, [reset]);

  const handleOpenFolder = useCallback(async () => {
    if (result?.outputPath) {
      await window.electron.exporter.showInFolder(result.outputPath);
    } else {
      await window.electron.exporter.openExportsFolder();
    }
  }, [result]);

  const handleOpenFile = useCallback(async () => {
    if (result?.outputPath) {
      await window.electron.exporter.openFile(result.outputPath);
    }
  }, [result]);

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return 'Unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatETA = (seconds: number): string => {
    if (seconds <= 0) return 'Calculating...';
    if (seconds < 60) return `${Math.round(seconds)}s remaining`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s remaining`;
  };

  const handleChooseOutput = useCallback(async () => {
    if (!project) return;
    const defaultExt = format;
    const defaultName = `${fileName || project.name}.${defaultExt}`;
    const chosen = await window.electron.recorder.showSaveDialog(defaultName);
    if (chosen) {
      // Normalize separators and split
      const parts = chosen.replace(/\\/g, '/').split('/');
      const chosenFile = parts.pop() || defaultName;
      const chosenFolder = parts.join('/');
      // Remove extension if present
      const nameNoExt = chosenFile.replace(new RegExp(`\\.${defaultExt}$`, 'i'), '');
      setFileName(nameNoExt);
      setOutputFolder(chosenFolder);
    }
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 data-starting-style:opacity-0 data-ending-style:opacity-0 transition-opacity duration-200" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-card border border-border rounded-xl shadow-xl p-6 data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 transition-all duration-200">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <Dialog.Title className="text-lg font-semibold">
              {step === 'configure' && 'Export Video'}
              {step === 'exporting' && 'Exporting...'}
              {step === 'complete' && 'Export Complete'}
              {step === 'error' && 'Export Failed'}
            </Dialog.Title>
            <Dialog.Close className="text-muted-foreground hover:text-foreground transition-colors">
              <X className="size-5" />
            </Dialog.Close>
          </div>

          {/* Configure Step */}
          {step === 'configure' && (
            <div className="space-y-5">
              {/* Resolution */}
              <div className="space-y-2">
                <Label>Resolution</Label>
                <Select
                  value={resolution}
                  onValueChange={(val) => setResolution(val as ExportResolution)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOLUTION_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* Custom resolution inputs */}
                {resolution === 'custom' && (
                  <div className="flex gap-3 mt-2">
                    <div className="flex-1">
                      <Label className="text-xs text-muted-foreground">Width</Label>
                      <Input
                        type="number"
                        value={customWidth}
                        onChange={(e) => setCustomWidth(parseInt(e.target.value) || 1920)}
                        min={320}
                        max={7680}
                      />
                    </div>
                    <div className="flex-1">
                      <Label className="text-xs text-muted-foreground">Height</Label>
                      <Input
                        type="number"
                        value={customHeight}
                        onChange={(e) => setCustomHeight(parseInt(e.target.value) || 1080)}
                        min={240}
                        max={4320}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Quality */}
              <div className="space-y-2">
                <Label>Quality</Label>
                <Select value={quality} onValueChange={(val) => setQuality(val as ExportQuality)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUALITY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Frame Rate */}
              <div className="space-y-2">
                <Label>Frame Rate</Label>
                <p className="text-sm text-muted-foreground">
                  Matches the recorded video frame rate.
                </p>
              </div>

              {/* Output Folder and Filename */}
              <div className="space-y-2">
                <Label>Output</Label>
                <div className="flex gap-2">
                  <Input
                    value={fileName}
                    onChange={(e) => setFileName(e.target.value)}
                    placeholder="File name"
                  />
                  <Button onClick={handleChooseOutput} variant="outline">
                    <FolderOpen className="size-4" />
                    Choose...
                  </Button>
                </div>
                <div className="text-xs text-muted-foreground">
                  {outputFolder
                    ? `${outputFolder}/${fileName}.${format}`
                    : `Will export to default exports folder`}
                </div>
              </div>

              {/* Export Button */}
              <Button onClick={handleExport} className="w-full mt-2">
                <Download className="size-4" />
                Export Video
              </Button>
            </div>
          )}

          {/* Exporting Step */}
          {step === 'exporting' && progress && (
            <div className="space-y-4">
              {/* Overall Progress */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {progress.phase ||
                      (progress.stage === 'composition' ? 'Compositing...' : 'Finalizing...')}
                  </span>
                  {/*
                    Hidden while the current step cannot report progress. The
                    percentage would simply stop moving, which reads as a hang
                    -- the label and the sweeping bar say "working" honestly.
                  */}
                  {!progress.indeterminate && (
                    <span className="font-medium">{progress.percent}%</span>
                  )}
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={
                      progress.indeterminate
                        ? 'h-full w-1/3 bg-primary animate-[export-indeterminate_1.2s_ease-in-out_infinite]'
                        : 'h-full bg-primary transition-all duration-300 ease-out'
                    }
                    style={progress.indeterminate ? undefined : { width: `${progress.percent}%` }}
                  />
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-muted/50 rounded-lg p-3">
                  <div className="text-muted-foreground text-xs mb-1">Encoding Speed</div>
                  <div className="font-medium">{progress.fps.toFixed(1)} fps</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3">
                  <div className="text-muted-foreground text-xs mb-1">Time Remaining</div>
                  <div className="font-medium">
                    {progress.indeterminate ? 'Almost there' : formatETA(progress.eta)}
                  </div>
                </div>
              </div>

              {/* Cancel button */}
              <Button variant="outline" onClick={handleCancel} className="w-full">
                Cancel Export
              </Button>
            </div>
          )}

          {/* Complete Step */}
          {step === 'complete' && result && (
            <div className="space-y-6 py-8">
              {/* Confetti trigger on mount */}
              <ConfettiTrigger />

              {/* Animated checkmark */}
              <div className="flex flex-col items-center justify-center space-y-4">
                <div className="relative size-24 flex items-center justify-center">
                  <svg
                    className="size-24 text-green-500 drop-shadow-lg"
                    style={{
                      animation: 'checkmark 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
                    }}
                    viewBox="0 0 48 48"
                  >
                    <circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.1" />
                    <path
                      d="M20 28L14 22M20 28L34 14"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                      style={{
                        strokeDasharray: 40,
                        strokeDashoffset: 40,
                        animation:
                          'checkmark-stroke 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) 0.2s forwards',
                      }}
                    />
                  </svg>
                </div>

                {/* Done text */}
                <div className="text-center space-y-2">
                  <h2 className="text-3xl font-bold text-foreground">Done!</h2>
                  <p className="text-base text-muted-foreground">Your video is ready</p>
                </div>

                {/* File details */}
                <div className="bg-muted/50 rounded-lg px-4 py-3 w-full text-center text-sm">
                  <div className="text-muted-foreground mb-1">File saved</div>
                  <div className="font-medium text-foreground">
                    {formatFileSize(result.fileSize)}
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex gap-3">
                <Button
                  onClick={handleOpenFile}
                  className="flex-1 bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white shadow-lg"
                >
                  <Play className="mr-2 size-4" />
                  Open File
                </Button>
                <Button variant="outline" onClick={handleOpenFolder} className="flex-1">
                  <FolderOpen className="mr-2 size-4" />
                  Show Folder
                </Button>
              </div>

              {/* Close button */}
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                className="w-full text-muted-foreground hover:text-foreground"
              >
                Close
              </Button>

              {/* CSS animations */}
              <style>{`
                @keyframes checkmark {
                  0% {
                    opacity: 0;
                    transform: scale(0.3) rotate(-45deg);
                  }
                  100% {
                    opacity: 1;
                    transform: scale(1) rotate(0deg);
                  }
                }
                
                @keyframes checkmark-stroke {
                  from {
                    stroke-dashoffset: 40;
                  }
                  to {
                    stroke-dashoffset: 0;
                  }
                }
                
                @keyframes confetti-fall {
                  to {
                    transform: translateY(100vh) rotate(720deg);
                    opacity: 0;
                  }
                }
              `}</style>
            </div>
          )}

          {/* Error Step */}
          {step === 'error' && errorMessage && (
            <div className="space-y-4">
              <div className="flex items-center justify-center py-4">
                <div className="size-16 bg-destructive/10 rounded-full flex items-center justify-center">
                  <X className="size-8 text-destructive" />
                </div>
              </div>

              <div className="text-center space-y-1">
                <p className="font-medium text-destructive">Export Failed</p>
                <p className="text-sm text-muted-foreground">{errorMessage}</p>
              </div>

              <Button onClick={() => reset()} className="w-full">
                Try Again
              </Button>
            </div>
          )}

          {/* Loading indicator for exporting */}
          {step === 'exporting' && !progress && (
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="size-8 animate-spin text-primary" />
              <p className="mt-3 text-sm text-muted-foreground">Preparing export...</p>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
