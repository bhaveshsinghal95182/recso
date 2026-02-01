/**
 * TimeRuler — Clickable time ruler for seeking.
 */

import React, { useCallback, useMemo, useRef } from 'react';

interface TimeRulerProps {
  duration: number;
  onSeek: (timeMs: number) => void;
}

// Format seconds to MM:SS
function formatTimeShort(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function TimeRuler({ duration, onSeek }: TimeRulerProps) {
  const rulerRef = useRef<HTMLDivElement>(null);
  const LABEL_OFFSET = 120; // Width of track labels

  // Generate time marks based on duration
  const marks = useMemo(() => {
    const durationSec = Math.ceil(duration / 1000);
    const interval = durationSec <= 60 ? 5 : durationSec <= 300 ? 15 : 30;
    const result: number[] = [];

    for (let t = 0; t <= durationSec; t += interval) {
      result.push(t);
    }

    return result;
  }, [duration]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!rulerRef.current || duration <= 0) return;

      const rect = rulerRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left - LABEL_OFFSET;
      const trackWidth = rect.width - LABEL_OFFSET;

      if (clickX < 0) return;

      const ratio = Math.max(0, Math.min(1, clickX / trackWidth));
      onSeek(ratio * duration);
    },
    [duration, onSeek],
  );

  return (
    <div
      className="h-7 bg-card border-b border-border relative cursor-pointer"
      ref={rulerRef}
      onClick={handleClick}
    >
      <div className="flex h-full pl-[120px]">
        {marks.map((sec) => (
          <div key={sec} className="text-[10px] text-muted-foreground px-1 py-2 min-w-[60px]">
            {formatTimeShort(sec)}
          </div>
        ))}
      </div>
    </div>
  );
}
