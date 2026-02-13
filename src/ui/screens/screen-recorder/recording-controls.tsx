import { Loader2, Pause, Play, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatBytes, formatDuration } from '@/lib/utils';

interface RecordingControlsProps {
  status: 'idle' | 'recording' | 'paused';
  duration: number;
  bytesWritten: number;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  isStarting?: boolean;
}

export function RecordingControls({
  status,
  duration,
  bytesWritten,
  onStart,
  onStop,
  onPause,
  onResume,
  isStarting,
}: RecordingControlsProps) {
  if (status === 'idle') {
    return (
      <div className="flex flex-col items-center gap-4">
        <Button
          size="lg"
          onClick={onStart}
          disabled={isStarting}
          className="h-16 w-16 rounded-full bg-red-600 hover:bg-red-700 shadow-lg transition-all hover:scale-105"
        >
          {isStarting ? (
            <Loader2 className="h-6 w-6 animate-spin text-white" />
          ) : (
            <div className="h-4 w-6 rounded-full bg-white" /> // Standard record icon styling
          )}
        </Button>
        <div className="text-sm font-medium text-muted-foreground">
          {isStarting ? 'Starting...' : 'Start Recording'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-md mx-auto p-6 bg-card rounded-xl border shadow-sm animate-in fade-in slide-in-from-bottom-4">
      {/* Timer Display */}
      <div className="text-center space-y-1">
        <div className="text-4xl font-mono font-bold tracking-wider tabular-nums">
          {formatDuration(duration)}
        </div>
        <div className="text-xs text-muted-foreground font-mono">
          Size: {formatBytes(bytesWritten)} • {status === 'paused' ? 'PAUSED' : 'REC'}
        </div>

        {/* Recording Indicator */}
        <div className="flex justify-center mt-2">
          <div
            className={`h-2 w-2 rounded-full ${status === 'paused' ? 'bg-yellow-500' : 'bg-red-500 animate-pulse'}`}
          />
        </div>
      </div>

      {/* Control Buttons */}
      <div className="flex items-center gap-4">
        {status === 'recording' ? (
          <Button
            variant="outline"
            size="icon"
            onClick={onPause}
            className="h-12 w-12 rounded-full border-2 hover:bg-muted"
            title="Pause"
          >
            <Pause className="h-5 w-5 fill-current" />
          </Button>
        ) : (
          <Button
            variant="outline"
            size="icon"
            onClick={onResume}
            className="h-12 w-12 rounded-full border-2 hover:bg-muted"
            title="Resume"
          >
            <Play className="h-5 w-5 fill-current ml-1" />
          </Button>
        )}

        <Button
          variant="destructive"
          size="icon"
          onClick={onStop}
          className="h-16 w-16 rounded-full shadow-md hover:scale-105 transition-transform"
          title="Stop Recording"
        >
          <Square className="h-6 w-6 fill-current" />
        </Button>
      </div>
    </div>
  );
}
