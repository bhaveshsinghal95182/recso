/**
 * Export Progress Toast
 *
 * A persistent toast notification that tracks export progress
 * and allows clicking to open the export modal for details.
 */

import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';

import { useExportStore } from '@/store/export-store';

export function ExportProgressToast() {
  const { state, progress, result, isModalOpen, setModalOpen } = useExportStore();

  // Dismiss toast when modal opens
  useEffect(() => {
    if (isModalOpen) {
      toast.dismiss('export-progress');
    }
  }, [isModalOpen]);

  useEffect(() => {
    // Show toast when export starts (but only if modal is closed)
    if (state === 'exporting' && progress && !isModalOpen) {
      const toastId = 'export-progress';

      const handleToastClick = () => {
        setModalOpen(true);
      };

      // Calculate overall progress text
      const getProgressText = () => {
        if (progress.stage === 'composition') {
          return `Compositing: ${Math.round(progress.stagePercent)}%`;
        } else {
          return `Exporting: ${Math.round(progress.stagePercent)}%`;
        }
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
              {progress.fps > 0 ? `${progress.fps.toFixed(1)} fps` : 'Starting...'} •{' '}
              {formatETA(progress.eta)} remaining
            </div>
            {/* Progress bar */}
            <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress.percent}%` }}
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
    }

    // Show success toast when complete
    if (state === 'complete' && result?.success && !isModalOpen) {
      toast.dismiss('export-progress');
      toast.success('Export Complete!', {
        description: `File saved successfully`,
        duration: 5000,
        action: {
          label: 'Open',
          onClick: () => {
            if (result.outputPath) {
              window.electron.exporter.showInFolder(result.outputPath);
            }
          },
        },
      });
    }

    // Show error toast when failed
    if (state === 'error' && result && !result.success && !isModalOpen) {
      toast.dismiss('export-progress');
      toast.error('Export Failed', {
        description: result.error || 'Unknown error occurred',
        duration: 8000,
        action: {
          label: 'Retry',
          onClick: () => setModalOpen(true),
        },
      });
    }

    // Dismiss toast when idle
    if (state === 'idle') {
      toast.dismiss('export-progress');
    }
  }, [state, progress, result, isModalOpen, setModalOpen]);

  // Update the toast content as progress changes (but only if modal is closed)
  useEffect(() => {
    if (state === 'exporting' && progress && !isModalOpen) {
      const getProgressText = () => {
        if (progress.stage === 'composition') {
          return `Compositing: ${Math.round(progress.stagePercent)}%`;
        } else {
          return `Exporting: ${Math.round(progress.stagePercent)}%`;
        }
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
              {progress.fps > 0 ? `${progress.fps.toFixed(1)} fps` : 'Starting...'} •{' '}
              {formatETA(progress.eta)} remaining
            </div>
            {/* Progress bar */}
            <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress.percent}%` }}
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
  }, [state, progress, isModalOpen, setModalOpen]);

  return null; // This component only manages toasts
}
