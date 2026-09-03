/**
 * Export Progress Toast
 *
 * A persistent toast notification that tracks export progress
 * and allows clicking to open the export modal for details.
 */

import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';

import { assertNever } from '@/lib/utils';
import { useExportStore } from '@/store/export-store';

export function ExportProgressToast() {
  const { phase, isModalOpen, setModalOpen } = useExportStore();

  // Dismiss toast when modal opens
  useEffect(() => {
    if (isModalOpen) {
      toast.dismiss('export-progress');
    }
  }, [isModalOpen]);

  useEffect(() => {
    // Dismiss toast when idle
    if (phase.kind === 'idle') {
      toast.dismiss('export-progress');
      return;
    }

    // Everything below is toast-only feedback; the modal shows its own UI.
    if (isModalOpen) return;

    if (phase.kind === 'exporting') {
      const { progress } = phase;
      const toastId = 'export-progress';

      const handleToastClick = () => {
        setModalOpen(true);
      };

      // What to say, and whether a percentage means anything right now.
      //
      // The last steps of an export -- mixing the audio, writing the container
      // -- are single blocking calls that cannot report progress. Showing a
      // percentage through them means showing one that has stopped moving, and
      // a number that has stopped moving reads as a hang. The phase label says
      // what is actually happening instead.
      const getProgressText = () => {
        const stageLabel = progress.stage === 'composition' ? 'Compositing' : 'Exporting';
        const label = progress.phase || stageLabel;
        return progress.indeterminate
          ? `${label}...`
          : `${label}: ${Math.round(progress.stagePercent)}%`;
      };

      // Format ETA
      const formatETA = (seconds: number): string => {
        if (seconds <= 0) return 'Calculating...';
        if (seconds < 60) return `${Math.round(seconds)}s`;
        const mins = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return `${mins}m ${secs}s`;
      };

      toast.loading(
        <div className="flex items-center gap-3 cursor-pointer w-full" onClick={handleToastClick}>
          <Loader2 className="size-5 animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm">{getProgressText()}</div>
            <div className="text-xs text-muted-foreground">
              {progress.indeterminate
                ? 'This can take a moment on a long recording'
                : `${progress.fps > 0 ? `${progress.fps.toFixed(1)} fps` : 'Starting...'} • ${formatETA(progress.eta)} remaining`}
            </div>
            {/* Progress bar */}
            <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={
                  progress.indeterminate
                    ? 'h-full w-1/3 bg-primary animate-[export-indeterminate_1.2s_ease-in-out_infinite]'
                    : 'h-full bg-primary transition-all duration-300'
                }
                style={progress.indeterminate ? undefined : { width: `${progress.percent}%` }}
              />
            </div>
          </div>
        </div>,
        {
          id: toastId,
          duration: Infinity,
          closeButton: false,
          description: 'Click to view details',
        },
      );
      return;
    }

    // Show success toast when complete
    if (phase.kind === 'complete') {
      const { outputPath } = phase.result;
      toast.dismiss('export-progress');
      toast.success('Export Complete!', {
        description: `File saved successfully`,
        duration: 5000,
        action: {
          label: 'Open',
          onClick: () => {
            window.electron.exporter.showInFolder(outputPath);
          },
        },
      });
      return;
    }

    // Show error toast when failed
    if (phase.kind === 'error') {
      toast.dismiss('export-progress');
      toast.error('Export Failed', {
        description: phase.message,
        duration: 8000,
        action: {
          label: 'Retry',
          onClick: () => setModalOpen(true),
        },
      });
      return;
    }

    assertNever(phase);
  }, [phase, isModalOpen, setModalOpen]);

  // Update the toast content as progress changes (but only if modal is closed)
  useEffect(() => {
    if (phase.kind === 'exporting' && !isModalOpen) {
      const { progress } = phase;
      const getProgressText = () => {
        const stageLabel = progress.stage === 'composition' ? 'Compositing' : 'Exporting';
        const label = progress.phase || stageLabel;
        return progress.indeterminate
          ? `${label}...`
          : `${label}: ${Math.round(progress.stagePercent)}%`;
      };

      const formatETA = (seconds: number): string => {
        if (seconds <= 0) return 'Calculating...';
        if (seconds < 60) return `${Math.round(seconds)}s`;
        const mins = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return `${mins}m ${secs}s`;
      };

      const handleToastClick = () => {
        setModalOpen(true);
      };

      // Update existing toast
      toast.loading(
        <div className="flex items-center gap-3 cursor-pointer w-full" onClick={handleToastClick}>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm">{getProgressText()}</div>
            <div className="text-xs text-muted-foreground">
              {progress.indeterminate
                ? 'This can take a moment on a long recording'
                : `${progress.fps > 0 ? `${progress.fps.toFixed(1)} fps` : 'Starting...'} • ${formatETA(progress.eta)} remaining`}
            </div>
            {/* Progress bar */}
            <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={
                  progress.indeterminate
                    ? 'h-full w-1/3 bg-primary animate-[export-indeterminate_1.2s_ease-in-out_infinite]'
                    : 'h-full bg-primary transition-all duration-300'
                }
                style={progress.indeterminate ? undefined : { width: `${progress.percent}%` }}
              />
            </div>
          </div>
        </div>,
        {
          id: 'export-progress',
          duration: Infinity,
          closeButton: false,
          description: 'Click to view details',
        },
      );
    }
  }, [phase, isModalOpen, setModalOpen]);

  return null; // This component only manages toasts
}
