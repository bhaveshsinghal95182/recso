/**
 * Timeline Component
 *
 * Displays a ruler with time markers based on video duration,
 * a draggable playhead, and a track area for video/cuts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { deriveCursorTimelineRegions } from '@/screens/editor/cursor-timeline-regions';
import { type RegionVariant, TimelineRegion } from '@/screens/editor/timeline-region';
import { usePlaybackStore } from '@/store/playback-store';
import { useProjectStore } from '@/store/project-store';
import { useTimelineStore } from '@/store/timeline-store';
import { useUIStore } from '@/store/ui-store';
import type { CutRegion, ZoomSource } from '@/types';

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

type TimelineMode = 'cuts' | 'zoom' | 'cursor' | 'all';
type CutLane = 'screen' | 'webcam';
type SelectableRegionType = RegionVariant;

interface CutSelectionDrag {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface TimelineLaneProps {
  label: string;
  videoPath: string | null;
  laneClassName: string;
  compact?: boolean;
  showWaveform?: boolean;
  onDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}

function TimelineLane({
  label,
  videoPath,
  laneClassName,
  compact = false,
  showWaveform = true,
  onDoubleClick,
  children,
}: TimelineLaneProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground font-semibold">
          {label}
        </span>
        {onDoubleClick ? (
          <span className="text-[10px] text-muted-foreground/70">Double-click to add region</span>
        ) : null}
      </div>

      <div
        className={`relative ${compact ? 'h-10 sm:h-12' : 'h-20 sm:h-24'} rounded-md border border-border/50 overflow-hidden ${laneClassName}`}
        onDoubleClick={onDoubleClick}
      >
        {showWaveform ? <TimelineWaveform videoPath={videoPath} /> : null}
        {children}
      </div>
    </div>
  );
}

function createCenteredRegion(anchorMs: number, regionDurationMs: number, durationMs: number) {
  const halfDuration = regionDurationMs / 2;

  let startMs = anchorMs - halfDuration;
  let endMs = anchorMs + halfDuration;

  if (startMs < 0) {
    startMs = 0;
    endMs = Math.min(regionDurationMs, durationMs);
  }

  if (endMs > durationMs) {
    endMs = durationMs;
    startMs = Math.max(0, durationMs - regionDurationMs);
  }

  return {
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
  };
}

function getCutTargets(cut: CutRegion): { screen: boolean; webcam: boolean } {
  return {
    screen: cut.targets?.screen ?? true,
    webcam: cut.targets?.webcam ?? true,
  };
}

function hasCutOnLane(cut: CutRegion, lane: CutLane): boolean {
  return getCutTargets(cut)[lane];
}

function getSelectionBounds(selection: CutSelectionDrag) {
  const left = Math.min(selection.startX, selection.currentX);
  const right = Math.max(selection.startX, selection.currentX);
  const top = Math.min(selection.startY, selection.currentY);
  const bottom = Math.max(selection.startY, selection.currentY);

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function boxesIntersect(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function getSelectableTypesForMode(mode: TimelineMode): SelectableRegionType[] {
  if (mode === 'cuts') {
    return ['cut'];
  }

  if (mode === 'zoom') {
    return ['zoom'];
  }

  if (mode === 'cursor') {
    return ['cursor'];
  }

  return ['cut', 'zoom', 'cursor'];
}

export function Timeline() {
  const { project, mouseEvents } = useProjectStore();
  const { duration, currentTime, seek } = usePlaybackStore();
  const {
    cuts,
    selectedCutId,
    addCut,
    updateCut,
    removeCut,
    setSelectedCut,
    zoomRegionsBySource,
    setZoomSource,
    selectedZoomId,
    addZoom,
    updateZoom,
    removeZoom,
    setSelectedZoom,
    selectedCursorRegionId,
    setSelectedCursorRegion,
  } = useTimelineStore();
  const { setActivePropertiesTab } = useUIStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const suppressTrackClickRef = useRef(false);
  const [mode, setMode] = useState<TimelineMode>('cuts');
  const [trackScrollbarWidth, setTrackScrollbarWidth] = useState(0);
  const [selectedCutIds, setSelectedCutIds] = useState<string[]>([]);
  const [selectedZoomIds, setSelectedZoomIds] = useState<string[]>([]);
  const [selectedCursorRegionIds, setSelectedCursorRegionIds] = useState<string[]>([]);
  const [cutSelectionDrag, setCutSelectionDrag] = useState<CutSelectionDrag | null>(null);

  const webcamTimelineEnabled = Boolean(
    project?.webcamOverlay?.enabled && project?.webcamOverlay?.sourcePath,
  );
  const webcamVideoPath = project?.webcamOverlay?.sourcePath ?? null;
  const screenCuts = useMemo(() => cuts.filter((cut) => hasCutOnLane(cut, 'screen')), [cuts]);
  const webcamCuts = useMemo(() => cuts.filter((cut) => hasCutOnLane(cut, 'webcam')), [cuts]);
  const screenZoomRegions = zoomRegionsBySource.screen;
  const webcamZoomRegions = zoomRegionsBySource.webcam;
  const cursorRegions = useMemo(
    () => deriveCursorTimelineRegions(mouseEvents, duration),
    [mouseEvents, duration],
  );
  const cursorRegionOverrideIds = useMemo(
    () =>
      new Set(
        (project?.cursorRegionOverrides ?? [])
          .map((cursorOverride) => cursorOverride.regionId)
          .filter(
            (regionId): regionId is string => typeof regionId === 'string' && regionId.length > 0,
          ),
      ),
    [project?.cursorRegionOverrides],
  );

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
  const startSeekDrag = useCallback(
    (clientX: number) => {
      const time = clientXToTime(clientX);
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

  const handleTimelineMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) {
        return;
      }

      startSeekDrag(e.clientX);
    },
    [startSeekDrag],
  );

  const handleAddCutAtTime = useCallback(
    (timeMs: number, lane: CutLane) => {
      if (duration <= 0) {
        return;
      }

      const region = createCenteredRegion(timeMs, 2000, duration);
      void addCut(region.startMs, region.endMs, {
        screen: lane === 'screen',
        webcam: lane === 'webcam',
      });
    },
    [addCut, duration],
  );

  const handleAddZoomAtTime = useCallback(
    (timeMs: number, source: ZoomSource) => {
      if (duration <= 0) {
        return;
      }

      const region = createCenteredRegion(timeMs, 2000, duration);
      void addZoom(region.startMs, region.endMs, source);
    },
    [addZoom, duration],
  );

  const clearRegionSelections = useCallback(() => {
    setSelectedCutIds([]);
    setSelectedZoomIds([]);
    setSelectedCursorRegionIds([]);
    setCutSelectionDrag(null);
    setSelectedCut(null);
    setSelectedZoom(null);
    setSelectedCursorRegion(null);
  }, [setSelectedCut, setSelectedCursorRegion, setSelectedZoom]);

  const handleModeChange = useCallback(
    (nextMode: TimelineMode) => {
      setMode(nextMode);
      clearRegionSelections();

      if (nextMode === 'zoom' || nextMode === 'all') {
        void setZoomSource('screen');
      }
    },
    [clearRegionSelections, setZoomSource],
  );

  // Deselect cut/zoom when clicking on track area (not on a region)
  const handleTrackClick = useCallback(() => {
    if (suppressTrackClickRef.current) {
      suppressTrackClickRef.current = false;
      return;
    }

    clearRegionSelections();
  }, [clearRegionSelections]);

  const handleSelectCut = useCallback(
    (cutId: string) => {
      setSelectedCutIds([cutId]);
      setSelectedZoomIds([]);
      setSelectedCursorRegionIds([]);
      setCutSelectionDrag(null);
      setSelectedCut(cutId);
      setSelectedZoom(null);
      setSelectedCursorRegion(null);
    },
    [setSelectedCut, setSelectedCursorRegion, setSelectedZoom],
  );

  const handleSelectZoom = useCallback(
    (zoomId: string, source: ZoomSource) => {
      setSelectedCutIds([]);
      setSelectedZoomIds([zoomId]);
      setSelectedCursorRegionIds([]);
      setCutSelectionDrag(null);
      setSelectedCut(null);
      setSelectedZoom(zoomId);
      setSelectedCursorRegion(null);
      void setZoomSource(source);
      setActivePropertiesTab('zoom');
    },
    [
      setSelectedCut,
      setSelectedCursorRegion,
      setSelectedZoom,
      setZoomSource,
      setActivePropertiesTab,
    ],
  );

  const handleSelectCursor = useCallback(
    (regionId: string) => {
      setSelectedCutIds([]);
      setSelectedZoomIds([]);
      setSelectedCursorRegionIds([regionId]);
      setCutSelectionDrag(null);
      setSelectedCut(null);
      setSelectedZoom(null);
      setSelectedCursorRegion(regionId);
      setActivePropertiesTab('cursor');
    },
    [setSelectedCut, setSelectedCursorRegion, setSelectedZoom, setActivePropertiesTab],
  );

  const handleDeleteCutForLane = useCallback(
    (cut: CutRegion, lane: CutLane, deleteAllLinked: boolean) => {
      if (deleteAllLinked) {
        void removeCut(cut.id);
        setSelectedCutIds((existing) => existing.filter((id) => id !== cut.id));
        return;
      }

      const targets = getCutTargets(cut);
      if (!targets[lane]) {
        return;
      }

      const nextTargets = {
        ...targets,
        [lane]: false,
      };

      if (!nextTargets.screen && !nextTargets.webcam) {
        void removeCut(cut.id);
        setSelectedCutIds((existing) => existing.filter((id) => id !== cut.id));
        return;
      }

      void updateCut({
        ...cut,
        targets: nextTargets,
      });

      if (!nextTargets.screen || !nextTargets.webcam) {
        setSelectedCutIds((existing) => existing.filter((id) => id !== cut.id));
      }
    },
    [removeCut, updateCut],
  );

  const applyRegionSelectionDrag = useCallback(
    (selection: CutSelectionDrag) => {
      const trackElement = trackRef.current;
      if (!trackElement) {
        return;
      }

      const trackRect = trackElement.getBoundingClientRect();
      const scrollLeft = trackElement.scrollLeft;
      const scrollTop = trackElement.scrollTop;
      const selectionBounds = getSelectionBounds(selection);
      const selectableTypes = new Set<SelectableRegionType>(getSelectableTypesForMode(mode));
      const matchedRegionIds = {
        cut: new Set<string>(),
        zoom: new Set<string>(),
        cursor: new Set<string>(),
      };

      const regionElements = trackElement.querySelectorAll<HTMLElement>(
        '[data-region-id][data-region-type]',
      );
      for (const regionElement of regionElements) {
        const regionId = regionElement.dataset.regionId;
        const regionType = regionElement.dataset.regionType as SelectableRegionType | undefined;
        if (!regionId || !regionType || !selectableTypes.has(regionType)) {
          continue;
        }

        const regionRect = regionElement.getBoundingClientRect();
        const regionBounds = {
          left: regionRect.left - trackRect.left + scrollLeft,
          right: regionRect.right - trackRect.left + scrollLeft,
          top: regionRect.top - trackRect.top + scrollTop,
          bottom: regionRect.bottom - trackRect.top + scrollTop,
        };

        if (boxesIntersect(selectionBounds, regionBounds)) {
          matchedRegionIds[regionType].add(regionId);
        }
      }

      const nextSelectedCutIds = Array.from(matchedRegionIds.cut);
      const nextSelectedZoomIds = Array.from(matchedRegionIds.zoom);
      const nextSelectedCursorRegionIds = Array.from(matchedRegionIds.cursor);

      setSelectedCutIds(nextSelectedCutIds);
      setSelectedZoomIds(nextSelectedZoomIds);
      setSelectedCursorRegionIds(nextSelectedCursorRegionIds);
      setSelectedCut(nextSelectedCutIds.length === 1 ? nextSelectedCutIds[0] : null);

      if (nextSelectedZoomIds.length === 1) {
        const zoomId = nextSelectedZoomIds[0];
        setSelectedZoom(zoomId);
        if (screenZoomRegions.some((zoom) => zoom.id === zoomId)) {
          void setZoomSource('screen');
        } else if (webcamZoomRegions.some((zoom) => zoom.id === zoomId)) {
          void setZoomSource('webcam');
        }
      } else {
        setSelectedZoom(null);
      }

      setSelectedCursorRegion(
        nextSelectedCursorRegionIds.length === 1 ? nextSelectedCursorRegionIds[0] : null,
      );
    },
    [
      mode,
      screenZoomRegions,
      webcamZoomRegions,
      setSelectedCut,
      setSelectedCursorRegion,
      setSelectedZoom,
      setZoomSource,
    ],
  );

  const handleTrackAreaMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) {
        return;
      }

      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-region-id]')) {
        return;
      }

      const trackElement = trackRef.current;
      if (!trackElement) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const trackRect = trackElement.getBoundingClientRect();
      const startX = e.clientX - trackRect.left + trackElement.scrollLeft;
      const startY = e.clientY - trackRect.top + trackElement.scrollTop;
      let didDrag = false;

      setSelectedCutIds([]);
      setSelectedZoomIds([]);
      setSelectedCursorRegionIds([]);
      setSelectedCut(null);
      setSelectedZoom(null);
      setSelectedCursorRegion(null);

      const initialDrag: CutSelectionDrag = {
        startX,
        startY,
        currentX: startX,
        currentY: startY,
      };

      setCutSelectionDrag(initialDrag);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const currentX = moveEvent.clientX - trackRect.left + trackElement.scrollLeft;
        const currentY = moveEvent.clientY - trackRect.top + trackElement.scrollTop;
        const deltaX = Math.abs(currentX - startX);
        const deltaY = Math.abs(currentY - startY);

        if (!didDrag && (deltaX > 3 || deltaY > 3)) {
          didDrag = true;
          suppressTrackClickRef.current = true;
        }

        const nextDrag: CutSelectionDrag = {
          startX,
          startY,
          currentX,
          currentY,
        };

        setCutSelectionDrag(nextDrag);
        if (didDrag) {
          applyRegionSelectionDrag(nextDrag);
        }
      };

      const handleMouseUp = () => {
        setCutSelectionDrag(null);
        if (!didDrag) {
          clearRegionSelections();
        }

        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [
      applyRegionSelectionDrag,
      clearRegionSelections,
      setSelectedCut,
      setSelectedCutIds,
      setSelectedCursorRegion,
      setSelectedZoom,
      setSelectedZoomIds,
      setSelectedCursorRegionIds,
    ],
  );

  const updateTrackScrollbarWidth = useCallback(() => {
    const trackElement = trackRef.current;
    if (!trackElement) {
      setTrackScrollbarWidth(0);
      return;
    }

    setTrackScrollbarWidth(Math.max(0, trackElement.offsetWidth - trackElement.clientWidth));
  }, []);

  useEffect(() => {
    const trackElement = trackRef.current;
    if (!trackElement) {
      return;
    }

    updateTrackScrollbarWidth();
    const observer = new ResizeObserver(() => {
      updateTrackScrollbarWidth();
    });
    observer.observe(trackElement);

    return () => {
      observer.disconnect();
    };
  }, [updateTrackScrollbarWidth]);

  const modeRegionCount =
    mode === 'cuts'
      ? screenCuts.length + (webcamTimelineEnabled ? webcamCuts.length : 0)
      : mode === 'zoom'
        ? screenZoomRegions.length + (webcamTimelineEnabled ? webcamZoomRegions.length : 0)
        : mode === 'cursor'
          ? cursorRegions.length
          : screenCuts.length +
            (webcamTimelineEnabled ? webcamCuts.length : 0) +
            screenZoomRegions.length +
            cursorRegions.length +
            (webcamTimelineEnabled ? webcamZoomRegions.length : 0);

  useEffect(() => {
    updateTrackScrollbarWidth();
  }, [mode, modeRegionCount, webcamTimelineEnabled, updateTrackScrollbarWidth]);

  const hasVisibleRegions = modeRegionCount > 0;
  const isCutSelected = useCallback(
    (cutId: string) => selectedCutId === cutId || selectedCutIds.includes(cutId),
    [selectedCutId, selectedCutIds],
  );
  const isZoomSelected = useCallback(
    (zoomId: string) => selectedZoomId === zoomId || selectedZoomIds.includes(zoomId),
    [selectedZoomId, selectedZoomIds],
  );
  const isCursorSelected = useCallback(
    (cursorId: string) =>
      selectedCursorRegionId === cursorId || selectedCursorRegionIds.includes(cursorId),
    [selectedCursorRegionId, selectedCursorRegionIds],
  );

  const playheadPercent = timeToPercent(currentTime);
  const rulerWidthStyle =
    trackScrollbarWidth > 0 ? { width: `calc(100% - ${trackScrollbarWidth}px)` } : undefined;
  const cutSelectionBounds = cutSelectionDrag ? getSelectionBounds(cutSelectionDrag) : null;
  const cutSelectionOverlayStyle = cutSelectionBounds
    ? {
        left: cutSelectionBounds.left - (trackRef.current?.scrollLeft ?? 0),
        top: cutSelectionBounds.top - (trackRef.current?.scrollTop ?? 0),
        width: cutSelectionBounds.width,
        height: cutSelectionBounds.height,
      }
    : undefined;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden select-none">
      {/* Toolbar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-card/50">
        <span className="text-xs text-muted-foreground font-mono">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-[0.08em] text-muted-foreground font-semibold">
            Mode
          </span>
          <Select
            value={mode}
            onValueChange={(nextMode) => {
              if (!nextMode) {
                return;
              }

              handleModeChange(nextMode);
            }}
          >
            <SelectTrigger className="h-8 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cuts">Cuts</SelectItem>
              <SelectItem value="zoom">Zoom</SelectItem>
              <SelectItem value="cursor">Cursor</SelectItem>
              <SelectItem value="all">View All</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <span className="text-xs text-muted-foreground">
          {modeRegionCount} region{modeRegionCount !== 1 ? 's' : ''}
        </span>

        {(mode === 'cuts' || mode === 'all') && (
          <span className="text-xs text-muted-foreground/80">
            Ctrl+click delete removes cut on both lanes
          </span>
        )}

        {!webcamTimelineEnabled && mode !== 'cursor' && (
          <span className="text-xs text-muted-foreground/75">
            Webcam timeline hidden (overlay off)
          </span>
        )}
      </div>

      {/* Timeline content */}
      <div className="flex-1 min-h-0 flex flex-col px-4 py-2 overflow-hidden">
        {/* Ruler */}
        <div
          ref={containerRef}
          className="relative h-6 shrink-0 bg-muted/30 rounded cursor-pointer"
          onMouseDown={handleTimelineMouseDown}
          style={rulerWidthStyle}
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
            <button
              type="button"
              className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-red-500 rounded-sm pointer-events-auto cursor-ew-resize"
              onMouseDown={(event) => {
                event.stopPropagation();
                if (event.button !== 0) {
                  return;
                }

                startSeekDrag(event.clientX);
              }}
              aria-label="Drag playhead"
            />
          </div>
        </div>

        {/* Track area */}
        <div
          ref={trackRef}
          className="relative flex-1 mt-3 min-h-0 overflow-y-auto overflow-x-hidden"
          onMouseDown={handleTrackAreaMouseDown}
          onClick={handleTrackClick}
        >
          <div className="relative z-1 space-y-2 min-h-full">
            {/* Playhead line follows full region stack height */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-red-500/70 z-30 pointer-events-none"
              style={{ left: `${playheadPercent}%` }}
            />

            {cutSelectionOverlayStyle && (
              <div
                className="absolute z-40 pointer-events-none rounded border border-red-300/80 bg-red-500/10"
                style={cutSelectionOverlayStyle}
              />
            )}

            {mode === 'cuts' && (
              <>
                <TimelineLane
                  label="Recorder Timeline"
                  videoPath={project?.rawVideoPath ?? null}
                  laneClassName="bg-primary/15"
                  onDoubleClick={(event) => {
                    const timeMs = clientXToTime(event.clientX);
                    handleAddCutAtTime(timeMs, 'screen');
                  }}
                >
                  {screenCuts.map((cut) => (
                    <TimelineRegion
                      key={`recorder-cut-${cut.id}`}
                      region={cut}
                      duration={duration}
                      variant="cut"
                      label="CUT"
                      isSelected={isCutSelected(cut.id)}
                      onSelect={() => handleSelectCut(cut.id)}
                      onUpdate={updateCut}
                      onDelete={(intent) =>
                        handleDeleteCutForLane(cut, 'screen', intent?.deleteAllLinked ?? false)
                      }
                      dataCutId={cut.id}
                      dataRegionId={cut.id}
                      dataRegionType="cut"
                    />
                  ))}
                </TimelineLane>

                {webcamTimelineEnabled && (
                  <TimelineLane
                    label="Webcam Timeline"
                    videoPath={webcamVideoPath}
                    laneClassName="bg-violet-500/10"
                    onDoubleClick={(event) => {
                      const timeMs = clientXToTime(event.clientX);
                      handleAddCutAtTime(timeMs, 'webcam');
                    }}
                  >
                    {webcamCuts.map((cut) => (
                      <TimelineRegion
                        key={`webcam-cut-${cut.id}`}
                        region={cut}
                        duration={duration}
                        variant="cut"
                        label="CUT"
                        isSelected={isCutSelected(cut.id)}
                        onSelect={() => handleSelectCut(cut.id)}
                        onUpdate={updateCut}
                        onDelete={(intent) =>
                          handleDeleteCutForLane(cut, 'webcam', intent?.deleteAllLinked ?? false)
                        }
                        dataCutId={cut.id}
                        dataRegionId={cut.id}
                        dataRegionType="cut"
                      />
                    ))}
                  </TimelineLane>
                )}
              </>
            )}

            {mode === 'zoom' && (
              <>
                <TimelineLane
                  label="Recorder Zoom Timeline"
                  videoPath={project?.rawVideoPath ?? null}
                  laneClassName="bg-blue-500/10"
                  onDoubleClick={(event) => {
                    const timeMs = clientXToTime(event.clientX);
                    handleAddZoomAtTime(timeMs, 'screen');
                  }}
                >
                  {screenZoomRegions.map((zoom) => (
                    <TimelineRegion
                      key={`screen-zoom-${zoom.id}`}
                      region={zoom}
                      duration={duration}
                      variant="zoom"
                      label={`${zoom.zoomLevel.toFixed(1)}x`}
                      isSelected={isZoomSelected(zoom.id)}
                      onSelect={() => handleSelectZoom(zoom.id, 'screen')}
                      onUpdate={(updatedZoom) => updateZoom(updatedZoom, 'screen')}
                      onDelete={() => removeZoom(zoom.id, 'screen')}
                      dataRegionId={zoom.id}
                      dataRegionType="zoom"
                    />
                  ))}
                </TimelineLane>

                {webcamTimelineEnabled && (
                  <TimelineLane
                    label="Webcam Zoom Timeline"
                    videoPath={webcamVideoPath}
                    laneClassName="bg-sky-500/10"
                    onDoubleClick={(event) => {
                      const timeMs = clientXToTime(event.clientX);
                      handleAddZoomAtTime(timeMs, 'webcam');
                    }}
                  >
                    {webcamZoomRegions.map((zoom) => (
                      <TimelineRegion
                        key={`webcam-zoom-${zoom.id}`}
                        region={zoom}
                        duration={duration}
                        variant="zoom"
                        label={`${zoom.zoomLevel.toFixed(1)}x`}
                        isSelected={isZoomSelected(zoom.id)}
                        onSelect={() => handleSelectZoom(zoom.id, 'webcam')}
                        onUpdate={(updatedZoom) => updateZoom(updatedZoom, 'webcam')}
                        onDelete={() => removeZoom(zoom.id, 'webcam')}
                        dataRegionId={zoom.id}
                        dataRegionType="zoom"
                      />
                    ))}
                  </TimelineLane>
                )}
              </>
            )}

            {mode === 'cursor' && (
              <TimelineLane
                label="Cursor Timeline"
                videoPath={project?.rawVideoPath ?? null}
                laneClassName="bg-emerald-500/10"
              >
                {cursorRegions.map((region) => (
                  <TimelineRegion
                    key={region.id}
                    region={region}
                    duration={duration}
                    variant="cursor"
                    label={cursorRegionOverrideIds.has(region.id) ? 'CUSTOM' : 'CURSOR'}
                    editable={false}
                    isSelected={isCursorSelected(region.id)}
                    onSelect={() => handleSelectCursor(region.id)}
                    onUpdate={() => {}}
                    onDelete={() => {}}
                    dataRegionId={region.id}
                    dataRegionType="cursor"
                  />
                ))}
              </TimelineLane>
            )}

            {mode === 'all' && (
              <div className="space-y-2 min-w-0">
                <TimelineLane
                  label="Recorder Cuts"
                  videoPath={project?.rawVideoPath ?? null}
                  laneClassName="bg-primary/15"
                  compact
                  showWaveform={false}
                  onDoubleClick={(event) => {
                    const timeMs = clientXToTime(event.clientX);
                    handleAddCutAtTime(timeMs, 'screen');
                  }}
                >
                  {screenCuts.map((cut) => (
                    <TimelineRegion
                      key={`all-recorder-cut-${cut.id}`}
                      region={cut}
                      duration={duration}
                      variant="cut"
                      label="CUT"
                      isSelected={isCutSelected(cut.id)}
                      onSelect={() => handleSelectCut(cut.id)}
                      onUpdate={updateCut}
                      onDelete={(intent) =>
                        handleDeleteCutForLane(cut, 'screen', intent?.deleteAllLinked ?? false)
                      }
                      dataCutId={cut.id}
                      dataRegionId={cut.id}
                      dataRegionType="cut"
                    />
                  ))}
                </TimelineLane>

                {webcamTimelineEnabled && (
                  <TimelineLane
                    label="Webcam Cuts"
                    videoPath={webcamVideoPath}
                    laneClassName="bg-violet-500/10"
                    compact
                    showWaveform={false}
                    onDoubleClick={(event) => {
                      const timeMs = clientXToTime(event.clientX);
                      handleAddCutAtTime(timeMs, 'webcam');
                    }}
                  >
                    {webcamCuts.map((cut) => (
                      <TimelineRegion
                        key={`all-webcam-cut-${cut.id}`}
                        region={cut}
                        duration={duration}
                        variant="cut"
                        label="CUT"
                        isSelected={isCutSelected(cut.id)}
                        onSelect={() => handleSelectCut(cut.id)}
                        onUpdate={updateCut}
                        onDelete={(intent) =>
                          handleDeleteCutForLane(cut, 'webcam', intent?.deleteAllLinked ?? false)
                        }
                        dataCutId={cut.id}
                        dataRegionId={cut.id}
                        dataRegionType="cut"
                      />
                    ))}
                  </TimelineLane>
                )}

                <TimelineLane
                  label="Recorder Zoom"
                  videoPath={project?.rawVideoPath ?? null}
                  laneClassName="bg-blue-500/10"
                  compact
                  showWaveform={false}
                  onDoubleClick={(event) => {
                    const timeMs = clientXToTime(event.clientX);
                    handleAddZoomAtTime(timeMs, 'screen');
                  }}
                >
                  {screenZoomRegions.map((zoom) => (
                    <TimelineRegion
                      key={`all-screen-zoom-${zoom.id}`}
                      region={zoom}
                      duration={duration}
                      variant="zoom"
                      label={`${zoom.zoomLevel.toFixed(1)}x`}
                      isSelected={isZoomSelected(zoom.id)}
                      onSelect={() => handleSelectZoom(zoom.id, 'screen')}
                      onUpdate={(updatedZoom) => updateZoom(updatedZoom, 'screen')}
                      onDelete={() => removeZoom(zoom.id, 'screen')}
                      dataRegionId={zoom.id}
                      dataRegionType="zoom"
                    />
                  ))}
                </TimelineLane>

                {webcamTimelineEnabled && (
                  <TimelineLane
                    label="Webcam Zoom"
                    videoPath={webcamVideoPath}
                    laneClassName="bg-sky-500/10"
                    compact
                    showWaveform={false}
                    onDoubleClick={(event) => {
                      const timeMs = clientXToTime(event.clientX);
                      handleAddZoomAtTime(timeMs, 'webcam');
                    }}
                  >
                    {webcamZoomRegions.map((zoom) => (
                      <TimelineRegion
                        key={`all-webcam-zoom-${zoom.id}`}
                        region={zoom}
                        duration={duration}
                        variant="zoom"
                        label={`${zoom.zoomLevel.toFixed(1)}x`}
                        isSelected={isZoomSelected(zoom.id)}
                        onSelect={() => handleSelectZoom(zoom.id, 'webcam')}
                        onUpdate={(updatedZoom) => updateZoom(updatedZoom, 'webcam')}
                        onDelete={() => removeZoom(zoom.id, 'webcam')}
                        dataRegionId={zoom.id}
                        dataRegionType="zoom"
                      />
                    ))}
                  </TimelineLane>
                )}

                <TimelineLane
                  label="Cursor"
                  videoPath={project?.rawVideoPath ?? null}
                  laneClassName="bg-emerald-500/10"
                  compact
                  showWaveform={false}
                >
                  {cursorRegions.map((region) => (
                    <TimelineRegion
                      key={`all-cursor-${region.id}`}
                      region={region}
                      duration={duration}
                      variant="cursor"
                      label={cursorRegionOverrideIds.has(region.id) ? 'CUSTOM' : 'CURSOR'}
                      editable={false}
                      isSelected={isCursorSelected(region.id)}
                      onSelect={() => handleSelectCursor(region.id)}
                      onUpdate={() => {}}
                      onDelete={() => {}}
                      dataRegionId={region.id}
                      dataRegionType="cursor"
                    />
                  ))}
                </TimelineLane>

                {!webcamTimelineEnabled && (
                  <div className="px-1 text-[10px] text-muted-foreground/75">
                    Webcam layers are hidden because webcam overlay is off.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Placeholder text when no regions */}
          {!hasVisibleRegions && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground/50">
              {mode === 'cuts'
                ? 'Double-click the recorder/webcam lanes to add cut regions'
                : mode === 'zoom'
                  ? 'Double-click the recorder/webcam lanes to add zoom regions'
                  : mode === 'cursor'
                    ? 'No cursor movement data available for this project'
                    : 'View all layers in one stacked timeline with a shared playhead'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
