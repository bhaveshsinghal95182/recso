/**
 * Export Modal — Dialog for configuring and starting video exports.
 *
 * Features:
 * - Resolution selection (720p, 1080p, 4K, Custom)
 * - Format selection (MP4, WebM)
 * - Quality presets (Low, Medium, High, Lossless)
 * - FPS selection (24, 30, 60)
 * - Real-time progress tracking
 */

import { Dialog } from '@base-ui/react/dialog';
import { Download, FolderOpen, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

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
import type {
  ExportConfig,
  ExportFormat,
  ExportFPS,
  ExportProgress,
  ExportQuality,
  ExportResolution,
} from '@/types';

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

const FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: 'mp4', label: 'MP4 (H.264)' },
  { value: 'webm', label: 'WebM (VP9)' },
];

const QUALITY_OPTIONS: { value: ExportQuality; label: string }[] = [
  { value: 'low', label: 'Low (smaller file)' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High (recommended)' },
  { value: 'lossless', label: 'Lossless (largest file)' },
];

const FPS_OPTIONS: { value: ExportFPS; label: string }[] = [
  { value: 24, label: '24 fps (cinematic)' },
  { value: 30, label: '30 fps (standard)' },
  { value: 60, label: '60 fps (smooth)' },
];

export function ExportModal({ open, onOpenChange }: ExportModalProps) {
  const { project } = useProjectStore();
  const {
    state: exportState,
    progress,
    result,
    setExportState,
    setProgress,
    setResult,
    setModalOpen,
    reset,
  } = useExportStore();

  // Map export store state to modal step
  const step: ExportStep =
    exportState === 'idle'
      ? 'configure'
      : exportState === 'exporting'
        ? 'exporting'
        : exportState === 'complete'
          ? 'complete'
          : 'error';

  // Export configuration state
  const [resolution, setResolution] = useState<ExportResolution>('1080p');
  const [customWidth, setCustomWidth] = useState(1920);
  const [customHeight, setCustomHeight] = useState(1080);
  const [format, setFormat] = useState<ExportFormat>('mp4');
  const [quality, setQuality] = useState<ExportQuality>('high');
  const [fps, setFps] = useState<ExportFPS>(30);
  const [fileName, setFileName] = useState<string>('');
  const [outputFolder, setOutputFolder] = useState<string>('');

  // Sync modal open state with store
  useEffect(() => {
    setModalOpen(open);
  }, [open, setModalOpen]);

  // Reset state and pause playback when modal opens
  useEffect(() => {
    if (open) {
      // Only reset if not currently exporting
      if (exportState !== 'exporting') {
        reset();
      }
      // Pause playback to prevent high-frequency re-renders from currentTime updates
      // This fixes input lag in the modal
      const { isPlaying, pause } = usePlaybackStore.getState();
      if (isPlaying) {
        pause();
      }
    }
  }, [open, exportState, reset]);

  // Subscribe to progress updates (always, not just when modal is open)
  useEffect(() => {
    const unsubscribe = window.electron.exporter.onProgress((prog: ExportProgress) => {
      setProgress(prog);
    });

    return unsubscribe;
  }, [setProgress]);

  const handleExport = useCallback(async () => {
    if (!project) return;

    const config: ExportConfig = {
      resolution,
      customWidth: resolution === 'custom' ? customWidth : undefined,
      customHeight: resolution === 'custom' ? customHeight : undefined,
      format,
      quality,
      fps,
      backgroundColor: project.backgroundColor || '#000000',
      outputFolder: outputFolder || undefined,
      outputFilename: fileName || undefined,
      glRenderer: 'angle', // Enable GPU acceleration
    };

    setExportState('exporting');
    setProgress({
      percent: 0,
      currentFrame: 0,
      totalFrames: 0,
      fps: 0,
      eta: 0,
      stage: 'composition',
      stagePercent: 0,
    });

    try {
      const exportResult = await window.electron.exporter.start(config);
      setResult(exportResult);
      setExportState(exportResult.success ? 'complete' : 'error');
    } catch (err) {
      setResult({
        success: false,
        error: err instanceof Error ? err.message : 'Export failed',
      });
      setExportState('error');
    }
  }, [
    project,
    resolution,
    customWidth,
    customHeight,
    format,
    quality,
    fps,
    fileName,
    outputFolder,
    setExportState,
    setProgress,
    setResult,
  ]);

  const handleCancel = useCallback(async () => {
    await window.electron.exporter.cancel();
    reset();
  }, [reset]);

  const handleOpenFolder = useCallback(async () => {
    if (result?.outputPath) {
      await window.electron.exporter.showInFolder(result.outputPath);
    } else {
      await window.electron.exporter.openExportsFolder();
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
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-200" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-card border border-border rounded-xl shadow-xl p-6 data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95 transition-all duration-200">
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

              {/* Format */}
              <div className="space-y-2">
                <Label>Format</Label>
                <Select value={format} onValueChange={(val) => setFormat(val as ExportFormat)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FORMAT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                <Select
                  value={fps.toString()}
                  onValueChange={(val) => val && setFps(parseInt(val) as ExportFPS)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FPS_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value.toString()}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              {/* Composition Progress */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Composition</span>
                  <span className="font-medium">
                    {progress.stage === 'composition'
                      ? `${Math.round(progress.stagePercent)}%`
                      : '100%'}
                  </span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-300 ease-out"
                    style={{
                      width: `${progress.stage === 'composition' ? progress.stagePercent : 100}%`,
                    }}
                  />
                </div>
              </div>

              {/* Export Progress */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Exporting</span>
                  <span className="font-medium">
                    {progress.stage === 'export' ? `${Math.round(progress.stagePercent)}%` : '0%'}
                  </span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-300 ease-out"
                    style={{
                      width: `${progress.stage === 'export' ? progress.stagePercent : 0}%`,
                    }}
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
                  <div className="font-medium">{formatETA(progress.eta)}</div>
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
            <div className="space-y-4">
              <div className="flex items-center justify-center py-4">
                <div className="size-16 bg-green-500/10 rounded-full flex items-center justify-center">
                  <Download className="size-8 text-green-500" />
                </div>
              </div>

              <div className="text-center space-y-1">
                <p className="font-medium">Export Successful!</p>
                <p className="text-sm text-muted-foreground">
                  File size: {formatFileSize(result.fileSize)}
                </p>
              </div>

              <div className="flex gap-3">
                <Button variant="outline" onClick={handleOpenFolder} className="flex-1">
                  <FolderOpen className="size-4" />
                  Show in Folder
                </Button>
                <Button onClick={() => onOpenChange(false)} className="flex-1">
                  Done
                </Button>
              </div>
            </div>
          )}

          {/* Error Step */}
          {step === 'error' && result && (
            <div className="space-y-4">
              <div className="flex items-center justify-center py-4">
                <div className="size-16 bg-destructive/10 rounded-full flex items-center justify-center">
                  <X className="size-8 text-destructive" />
                </div>
              </div>

              <div className="text-center space-y-1">
                <p className="font-medium text-destructive">Export Failed</p>
                <p className="text-sm text-muted-foreground">{result.error || 'Unknown error'}</p>
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
