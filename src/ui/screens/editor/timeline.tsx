/**
 * Timeline Component
 *
 * Displays a ruler with time markers based on video duration,
 * a draggable playhead, and a track area for video/cuts.
 */

import { Scissors, ZoomIn } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { TimelineRegion } from '@/screens/editor/timeline-region';
import { usePlaybackStore } from '@/store/playback-store';
import { useProjectStore } from '@/store/project-store';
import { useTimelineStore } from '@/store/timeline-store';
import { useUIStore } from '@/store/ui-store';

const WAVEFORM_PEAK_COUNT = 2048;
const waveformPeakCache = new Map<string, Promise<Float32Array>>();

function toFileUrl(path: string): string {
  if (path.startsWith('file:')) {
    return path;
  }

  const normalized = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }

  if (normalized.startsWith('/')) {
    return `file://${encodeURI(normalized)}`;
  }

  return normalized;
}

function extractWaveformPeaks(audioBuffer: AudioBuffer, targetCount: number): Float32Array {
  const channelData = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) =>
    audioBuffer.getChannelData(index),
  );
  const peakCount = Math.max(64, targetCount);
  const totalSamples = audioBuffer.length;
  const samplesPerPeak = Math.max(1, Math.floor(totalSamples / peakCount));
  const peaks = new Float32Array(peakCount);
  let maxPeak = 0;

  for (let peakIndex = 0; peakIndex < peakCount; peakIndex += 1) {
    const start = peakIndex * samplesPerPeak;
    const end =
      peakIndex === peakCount - 1 ? totalSamples : Math.min(totalSamples, start + samplesPerPeak);
    const span = Math.max(1, end - start);
    const stride = Math.max(1, Math.floor(span / 128));
    let localPeak = 0;

    for (const channel of channelData) {
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += stride) {
        const amplitude = Math.abs(channel[sampleIndex] ?? 0);
        if (amplitude > localPeak) {
          localPeak = amplitude;
        }
      }
    }

    peaks[peakIndex] = localPeak;
    if (localPeak > maxPeak) {
      maxPeak = localPeak;
    }
  }

  if (maxPeak > 0) {
    for (let index = 0; index < peaks.length; index += 1) {
      peaks[index] /= maxPeak;
    }
  }

  return peaks;
}

async function loadWaveformPeaks(videoPath: string): Promise<Float32Array> {
  const cached = waveformPeakCache.get(videoPath);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const sourceUrl = toFileUrl(videoPath);
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`Failed to read media for waveform (${response.status})`);
    }

    const bytes = await response.arrayBuffer();
    const audioContext = new AudioContext();
    try {
      const decoded = await audioContext.decodeAudioData(bytes.slice(0));
      return extractWaveformPeaks(decoded, WAVEFORM_PEAK_COUNT);
    } finally {
      await audioContext.close().catch(() => {
        // Best-effort cleanup.
      });
    }
  })();

  waveformPeakCache.set(videoPath, pending);

  try {
    return await pending;
  } catch (error) {
    waveformPeakCache.delete(videoPath);
    throw error;
  }
}

interface TimelineWaveformProps {
  videoPath: string | null;
}

function TimelineWaveform({ videoPath }: TimelineWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);

  useEffect(() => {
    if (!videoPath) {
      setPeaks(null);
      return;
    }

    let cancelled = false;

    void loadWaveformPeaks(videoPath)
      .then((nextPeaks) => {
        if (!cancelled) {
          setPeaks(nextPeaks);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPeaks(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [videoPath]);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(rect.width));
    const cssHeight = Math.max(1, Math.floor(rect.height));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const bufferWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const bufferHeight = Math.max(1, Math.floor(cssHeight * dpr));

    if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
      canvas.width = bufferWidth;
      canvas.height = bufferHeight;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (!peaks || peaks.length === 0) {
      return;
    }

    const centerY = cssHeight / 2;
    const barStepPx = 2;
    const barWidthPx = 1;

    ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
    for (let x = 0; x < cssWidth; x += barStepPx) {
      const start = Math.floor((x / cssWidth) * peaks.length);
      const end = Math.min(peaks.length, Math.ceil(((x + barStepPx) / cssWidth) * peaks.length));

      let peak = 0;
      for (let index = start; index < end; index += 1) {
        const value = peaks[index] ?? 0;
        if (value > peak) {
          peak = value;
        }
      }

      const barHeight = Math.max(1, peak * cssHeight * 0.9);
      const y = centerY - barHeight / 2;
      ctx.fillRect(x, y, barWidthPx, barHeight);
    }
  }, [peaks]);

  useEffect(() => {
    drawWaveform();
  }, [drawWaveform]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const observer = new ResizeObserver(() => {
      drawWaveform();
    });
    observer.observe(canvas);

    return () => {
      observer.disconnect();
    };
  }, [drawWaveform]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
}

/**
 * Format milliseconds to MM:SS format
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Calculate tick interval based on duration for readable ruler
 */
function getTickInterval(durationMs: number): { major: number; minor: number } {
  const durationSec = durationMs / 1000;

  if (durationSec <= 10) {
    return { major: 5000, minor: 1000 }; // 5s major, 1s minor
  } else if (durationSec <= 30) {
    return { major: 5000, minor: 1000 };
  } else if (durationSec <= 60) {
    return { major: 10000, minor: 2000 };
  } else if (durationSec <= 180) {
    return { major: 30000, minor: 5000 };
  } else if (durationSec <= 600) {
    return { major: 60000, minor: 10000 };
  } else {
    return { major: 120000, minor: 30000 };
  }
}

export function Timeline() {
  const { project } = useProjectStore();
  const { duration, currentTime, seek } = usePlaybackStore();
  const {
    cuts,
    selectedCutId,
    addCut,
    updateCut,
    removeCut,
    setSelectedCut,
    zoomRegions,
    selectedZoomId,
    addZoom,
    updateZoom,
    removeZoom,
    setSelectedZoom,
  } = useTimelineStore();
  const { setActivePropertiesTab } = useUIStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const { major: majorInterval, minor: minorInterval } = getTickInterval(duration);

  // Generate tick marks based on duration
  const ticks = useMemo<{ time: number; isMajor: boolean }[]>(() => {
    const t: { time: number; isMajor: boolean }[] = [];
    for (let i = 0; i <= duration; i += minorInterval) {
      t.push({
        time: i,
        isMajor: i % majorInterval === 0,
      });
    }
    return t;
  }, [duration, majorInterval, minorInterval]);

  // Convert time to percentage position
  const timeToPercent = (time: number) => (duration > 0 ? (time / duration) * 100 : 0);

  // Convert clientX to time
  const clientXToTime = useCallback(
    (clientX: number) => {
      if (!containerRef.current || duration <= 0) return 0;
      const rect = containerRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const percent = Math.max(0, Math.min(1, x / rect.width));
      return percent * duration;
    },
    [duration],
  );

  // Handle seeking via click or drag
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const time = clientXToTime(e.clientX);
      seek(time);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const newTime = clientXToTime(moveEvent.clientX);
        seek(newTime);
      };

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [clientXToTime, seek],
  );

  // Handle Add Cut at current playhead position
  const handleAddCut = useCallback(() => {
    if (duration <= 0) return;

    // Create a 2-second cut region centered on playhead
    const cutDuration = 2000; // 2 seconds
    const halfDuration = cutDuration / 2;

    let startMs = currentTime - halfDuration;
    let endMs = currentTime + halfDuration;

    // Clamp to video bounds
    if (startMs < 0) {
      startMs = 0;
      endMs = Math.min(cutDuration, duration);
    }
    if (endMs > duration) {
      endMs = duration;
      startMs = Math.max(0, duration - cutDuration);
    }

    addCut(startMs, endMs);
  }, [currentTime, duration, addCut]);

  // Handle Add Zoom at current playhead position
  const handleAddZoom = useCallback(() => {
    if (duration <= 0) return;

    // Create a 2-second zoom region centered on playhead
    const zoomDuration = 2000; // 2 seconds
    const halfDuration = zoomDuration / 2;

    let startMs = currentTime - halfDuration;
    let endMs = currentTime + halfDuration;

    // Clamp to video bounds
    if (startMs < 0) {
      startMs = 0;
      endMs = Math.min(zoomDuration, duration);
    }
    if (endMs > duration) {
      endMs = duration;
      startMs = Math.max(0, duration - zoomDuration);
    }

    addZoom(startMs, endMs);
  }, [currentTime, duration, addZoom]);

  // Deselect cut/zoom when clicking on track area (not on a region)
  const handleTrackClick = useCallback(() => {
    setSelectedCut(null);
    setSelectedZoom(null);
  }, [setSelectedCut, setSelectedZoom]);

  const playheadPercent = timeToPercent(currentTime);

  return (
    <div className="flex flex-col h-full select-none">
      {/* Toolbar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-card/50">
        <span className="text-xs text-muted-foreground font-mono">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        {/* Add Cut button */}
        <button
          type="button"
          onClick={handleAddCut}
          className="flex items-center py-1 rotate-270 cursor-pointer"
          title="Add cut at playhead"
        >
          <Scissors className="w-4 h-4" />
        </button>

        {/* Add Zoom button */}
        <button
          type="button"
          onClick={handleAddZoom}
          className="flex items-center py-1 cursor-pointer"
          title="Add zoom at playhead"
        >
          <ZoomIn className="w-4 h-4" />
        </button>

        {/* Cut count indicator */}
        {cuts.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {cuts.length} cut{cuts.length !== 1 ? 's' : ''}
          </span>
        )}

        {/* Zoom count indicator */}
        {zoomRegions.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {zoomRegions.length} zoom{zoomRegions.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Timeline content */}
      <div className="flex-1 flex flex-col px-4 py-2 overflow-hidden">
        {/* Ruler */}
        <div
          ref={containerRef}
          className="relative h-6 bg-muted/30 rounded cursor-pointer"
          onMouseDown={handleMouseDown}
        >
          {/* Tick marks */}
          {ticks.map((tick) => (
            <div
              key={tick.time}
              className="absolute top-0 flex flex-col items-center"
              style={{ left: `${timeToPercent(tick.time)}%` }}
            >
              <div
                className={`w-px ${tick.isMajor ? 'h-3 bg-muted-foreground' : 'h-2 bg-muted-foreground/50'}`}
              />
              {tick.isMajor && (
                <span className="text-[10px] text-muted-foreground mt-0.5 -translate-x-1/2">
                  {formatTime(tick.time)}
                </span>
              )}
            </div>
          ))}

          {/* Playhead */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10 pointer-events-none"
            style={{ left: `${playheadPercent}%` }}
          >
            {/* Playhead handle */}
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-red-500 rounded-sm" />
          </div>
        </div>

        {/* Track area */}
        <div
          ref={trackRef}
          className="relative flex-1 mt-2 bg-muted/20 rounded border border-border/50 min-h-20"
          onClick={handleTrackClick}
        >
          {/* Video track background */}
          <div className="absolute inset-y-2 left-0 right-0 mx-1 bg-primary/20 rounded">
            <TimelineWaveform videoPath={project?.rawVideoPath ?? null} />

            {/* Cut regions */}
            {cuts.map((cut) => (
              <TimelineRegion
                key={cut.id}
                region={cut}
                duration={duration}
                variant="cut"
                label="CUT"
                isSelected={selectedCutId === cut.id}
                onSelect={() => setSelectedCut(cut.id)}
                onUpdate={updateCut}
                onDelete={() => removeCut(cut.id)}
              />
            ))}

            {/* Zoom regions */}
            {zoomRegions.map((zoom) => (
              <TimelineRegion
                key={zoom.id}
                region={zoom}
                duration={duration}
                variant="zoom"
                label={`${zoom.zoomLevel.toFixed(1)}x`}
                isSelected={selectedZoomId === zoom.id}
                onSelect={() => {
                  setSelectedZoom(zoom.id);
                  setActivePropertiesTab('zoom');
                }}
                onUpdate={updateZoom}
                onDelete={() => removeZoom(zoom.id)}
              />
            ))}
          </div>

          {/* Playhead line in track area */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-red-500/70 z-10 pointer-events-none"
            style={{ left: `${playheadPercent}%` }}
          />

          {/* Placeholder text when no regions */}
          {cuts.length === 0 && zoomRegions.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground/50">
              Click "Add Cut" or "Add Zoom" to add timeline regions
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
