/**
 * Timeline Component
 *
 * A ruler with time markers, a draggable playhead, and a stack of lanes.
 * Every lane renders at the same height and shares one neutral surface, so the
 * timeline reads as a single object instead of a pile of colour-coded tracks.
 */

import { MousePointer2, Scissors, Video, ZoomIn } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useSpritesheets } from '@/hooks/useSpritesheets';
import { cn } from '@/lib/utils';
import { deriveCursorTimelineRegions } from '@/screens/editor/cursor-timeline-regions';
import {
  mapCompositionToSourceTimeMs,
  mapSourceTimeToCompositionTimeMs,
} from '@/screens/editor/engine/functions';
import { TimelineFilmstrip } from '@/screens/editor/timeline-filmstrip';
import {
  regionAccentText,
  type RegionVariant,
  TimelineRegion,
} from '@/screens/editor/timeline-region';
import { timeToPercent as toTimelinePercent } from '@/screens/editor/timeline-scale';
import { TimelineWaveform } from '@/screens/editor/timeline-waveform';
import { usePlaybackStore } from '@/store/playback-store';
import { useProjectStore } from '@/store/project-store';
import {
  focusedCursorRegionId,
  focusedCutId,
  focusedZoomId,
  useTimelineStore,
} from '@/store/timeline-store';
import { useUIStore } from '@/store/ui-store';
import type { CutRegion, SpritesheetMeta, ZoomSource } from '@/types';

/** Width of the fixed label column that fronts the ruler and every lane. */
const LANE_GUTTER_PX = 112;
/** Standard height shared by every lane, in every filter. */
const LANE_HEIGHT_PX = 44;
const LANE_GAP_PX = 6;

const surface =
  'bg-[linear-gradient(180deg,rgba(255,255,255,0.045),transparent_42%),rgba(12,14,14,0.94)]';

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

type TimelineMode = 'all' | 'cuts' | 'zoom' | 'cursor';
type CutLane = 'screen' | 'webcam';
type SelectableRegionType = RegionVariant;

interface CutSelectionDrag {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface LaneConfig {
  id: string;
  /** What the lane holds — "Cut", "Zoom", "Cursor". */
  typeLabel: string;
  /** Which media the lane applies to — "Screen" or "Webcam". */
  label: string;
  kind: RegionVariant;
  videoPath: string | null;
  /** The lane's thumbnail sheet, absent until one has been generated. */
  sheet?: SpritesheetMeta;
  regionCount: number;
  regions: ReactNode;
  emptyHint: string;
  onDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
}

const laneIcons: Record<RegionVariant, typeof Scissors> = {
  cut: Scissors,
  zoom: ZoomIn,
  cursor: MousePointer2,
};

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
    focus,
    addCut,
    updateCut,
    removeCut,
    focusCut,
    zoomRegionsBySource,
    setZoomSource,
    addZoom,
    updateZoom,
    removeZoom,
    focusZoom,
    focusCursorRegion,
    clearFocus,
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
  // Arrives after the editor does -- a fresh recording's sheets are still
  // decoding while the timeline is already interactive.
  const spritesheets = useSpritesheets();
  const screenVideoPath = project?.rawVideoPath ?? null;
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
  const timeToPercent = (time: number) => toTimelinePercent(time, duration);

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
      const seekToTimelineTime = (timelineTime: number) =>
        seek(mapSourceTimeToCompositionTimeMs(timelineTime, screenCuts));

      seekToTimelineTime(clientXToTime(clientX));

      const handleMouseMove = (moveEvent: MouseEvent) => {
        seekToTimelineTime(clientXToTime(moveEvent.clientX));
      };

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [clientXToTime, screenCuts, seek],
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
    clearFocus();
  }, [clearFocus]);

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
      focusCut(cutId);
    },
    [focusCut],
  );

  const handleSelectZoom = useCallback(
    (zoomId: string, source: ZoomSource) => {
      setSelectedCutIds([]);
      setSelectedZoomIds([zoomId]);
      setSelectedCursorRegionIds([]);
      setCutSelectionDrag(null);
      focusZoom(zoomId);
      void setZoomSource(source);
      // Webcam regions are edited in the webcam panel, screen regions in the zoom panel.
      setActivePropertiesTab(source === 'webcam' ? 'webcam' : 'zoom');
    },
    [focusZoom, setZoomSource, setActivePropertiesTab],
  );

  const handleSelectCursor = useCallback(
    (regionId: string) => {
      setSelectedCutIds([]);
      setSelectedZoomIds([]);
      setSelectedCursorRegionIds([regionId]);
      setCutSelectionDrag(null);
      focusCursorRegion(regionId);
      setActivePropertiesTab('cursor');
    },
    [focusCursorRegion, setActivePropertiesTab],
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

      // A marquee in 'all' mode can span several region types, but the
      // properties panel edits exactly one region. Only take focus when the
      // drag landed on a single region overall — anything else is ambiguous,
      // so leave the marquee selection alone and drop focus.
      const totalMatched =
        nextSelectedCutIds.length + nextSelectedZoomIds.length + nextSelectedCursorRegionIds.length;

      if (totalMatched !== 1) {
        clearFocus();
        return;
      }

      if (nextSelectedCutIds.length === 1) {
        focusCut(nextSelectedCutIds[0]);
        return;
      }

      if (nextSelectedZoomIds.length === 1) {
        const zoomId = nextSelectedZoomIds[0];
        focusZoom(zoomId);
        if (screenZoomRegions.some((zoom) => zoom.id === zoomId)) {
          void setZoomSource('screen');
        } else if (webcamZoomRegions.some((zoom) => zoom.id === zoomId)) {
          void setZoomSource('webcam');
        }
        return;
      }

      focusCursorRegion(nextSelectedCursorRegionIds[0]);
    },
    [
      mode,
      screenZoomRegions,
      webcamZoomRegions,
      focusCut,
      focusZoom,
      focusCursorRegion,
      clearFocus,
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
      clearFocus();

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
      clearFocus,
      setSelectedCutIds,
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

  const isCutSelected = useCallback(
    (cutId: string) => focusedCutId(focus) === cutId || selectedCutIds.includes(cutId),
    [focus, selectedCutIds],
  );
  const isZoomSelected = useCallback(
    (zoomId: string) => focusedZoomId(focus) === zoomId || selectedZoomIds.includes(zoomId),
    [focus, selectedZoomIds],
  );
  const isCursorSelected = useCallback(
    (cursorId: string) =>
      focusedCursorRegionId(focus) === cursorId || selectedCursorRegionIds.includes(cursorId),
    [focus, selectedCursorRegionIds],
  );

  const cutLaneCount = screenCuts.length + (webcamTimelineEnabled ? webcamCuts.length : 0);
  const zoomLaneCount =
    screenZoomRegions.length + (webcamTimelineEnabled ? webcamZoomRegions.length : 0);
  const counts: Record<TimelineMode, number> = {
    cuts: cutLaneCount,
    zoom: zoomLaneCount,
    cursor: cursorRegions.length,
    all: cutLaneCount + zoomLaneCount + cursorRegions.length,
  };

  const buildCutLane = (lane: CutLane): LaneConfig => {
    const laneCuts = lane === 'screen' ? screenCuts : webcamCuts;

    return {
      id: `${lane}-cuts`,
      typeLabel: 'Cut',
      label: lane === 'screen' ? 'Screen' : 'Webcam',
      kind: 'cut',
      videoPath: lane === 'screen' ? screenVideoPath : webcamVideoPath,
      sheet: spritesheets[lane],
      regionCount: laneCuts.length,
      emptyHint: 'Double-click to add a cut',
      onDoubleClick: (event) => handleAddCutAtTime(clientXToTime(event.clientX), lane),
      regions: laneCuts.map((cut) => (
        <TimelineRegion
          key={`${lane}-cut-${cut.id}`}
          region={cut}
          duration={duration}
          variant="cut"
          label="Cut"
          isSelected={isCutSelected(cut.id)}
          onSelect={() => handleSelectCut(cut.id)}
          onUpdate={updateCut}
          onDelete={(intent) => handleDeleteCutForLane(cut, lane, intent?.deleteAllLinked ?? false)}
          dataCutId={cut.id}
          dataRegionId={cut.id}
          dataRegionType="cut"
        />
      )),
    };
  };

  const buildZoomLane = (source: ZoomSource): LaneConfig => {
    const laneZooms = source === 'screen' ? screenZoomRegions : webcamZoomRegions;

    return {
      id: `${source}-zoom`,
      typeLabel: 'Zoom',
      label: source === 'screen' ? 'Screen' : 'Webcam',
      kind: 'zoom',
      videoPath: null,
      regionCount: laneZooms.length,
      emptyHint: 'Double-click to add a zoom',
      onDoubleClick: (event) => handleAddZoomAtTime(clientXToTime(event.clientX), source),
      regions: laneZooms.map((zoom) => (
        <TimelineRegion
          key={`${source}-zoom-${zoom.id}`}
          region={zoom}
          duration={duration}
          variant="zoom"
          label={`${zoom.zoomLevel.toFixed(1)}x`}
          isSelected={isZoomSelected(zoom.id)}
          onSelect={() => handleSelectZoom(zoom.id, source)}
          onUpdate={(updatedZoom) => updateZoom(updatedZoom, source)}
          onDelete={() => removeZoom(zoom.id, source)}
          dataRegionId={zoom.id}
          dataRegionType="zoom"
        />
      )),
    };
  };

  const buildCursorLane = (): LaneConfig => ({
    id: 'cursor',
    typeLabel: 'Cursor',
    label: 'Screen',
    kind: 'cursor',
    videoPath: null,
    regionCount: cursorRegions.length,
    emptyHint: 'No cursor data recorded for this project',
    regions: cursorRegions.map((region) => (
      <TimelineRegion
        key={`cursor-${region.id}`}
        region={region}
        duration={duration}
        variant="cursor"
        label={cursorRegionOverrideIds.has(region.id) ? 'Custom' : 'Cursor'}
        editable={false}
        isSelected={isCursorSelected(region.id)}
        onSelect={() => handleSelectCursor(region.id)}
        onUpdate={() => {}}
        onDelete={() => {}}
        dataRegionId={region.id}
        dataRegionType="cursor"
      />
    )),
  });

  const lanes: LaneConfig[] = [];
  if (mode === 'cuts' || mode === 'all') {
    lanes.push(buildCutLane('screen'));
    if (webcamTimelineEnabled) {
      lanes.push(buildCutLane('webcam'));
    }
  }
  if (mode === 'zoom' || mode === 'all') {
    lanes.push(buildZoomLane('screen'));
    if (webcamTimelineEnabled) {
      lanes.push(buildZoomLane('webcam'));
    }
  }
  if (mode === 'cursor' || mode === 'all') {
    lanes.push(buildCursorLane());
  }

  useEffect(() => {
    updateTrackScrollbarWidth();
  }, [mode, counts.all, webcamTimelineEnabled, updateTrackScrollbarWidth]);

  const playheadPercent = timeToPercent(mapCompositionToSourceTimeMs(currentTime, screenCuts));
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
  const laneGridStyle = {
    gridTemplateColumns: `${LANE_GUTTER_PX}px minmax(0,1fr)`,
    rowGap: LANE_GAP_PX,
  };

  return (
    <div className={cn('flex h-full min-h-0 select-none flex-col overflow-hidden', surface)}>
      {/* Toolbar */}
      <div className="flex flex-none items-center gap-3 border-b border-white/[0.07] px-4 py-2.5">
        <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
          <span className="text-[15px] font-[650] text-white/90">{formatTime(currentTime)}</span>
          <span className="text-[11px] text-white/35">/ {formatTime(duration)}</span>
        </div>

        {!webcamTimelineEnabled && mode !== 'cursor' && (
          <span className="flex items-center gap-1.5 text-[11px] text-white/30">
            <Video size={12} />
            Webcam off
          </span>
        )}

        <div className="ml-auto flex flex-none gap-1 rounded-[14px] border border-white/[0.07] bg-black/40 p-[4px]">
          {(['all', 'cuts', 'zoom', 'cursor'] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              className={cn(
                'flex cursor-pointer items-center gap-[7px] rounded-[10px] px-[11px] py-[6px] text-white/50 transition duration-150 hover:text-white/80',
                mode === filter && 'bg-white/10 text-white hover:text-white',
              )}
              onClick={() => handleModeChange(filter)}
            >
              <span className="text-[12px] font-[700] capitalize">{filter}</span>
              <strong className="text-[11px] tabular-nums text-white/40">{counts[filter]}</strong>
            </button>
          ))}
        </div>
      </div>

      {/* Timeline content */}
      <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
        {/* Ruler */}
        <div className="grid flex-none" style={laneGridStyle}>
          <div />
          <div
            ref={containerRef}
            className="relative h-7 cursor-pointer"
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
                  className={cn('w-px', tick.isMajor ? 'h-2 bg-white/25' : 'h-1.5 bg-white/10')}
                />
                {tick.isMajor && (
                  <span className="mt-1 -translate-x-1/2 font-mono text-[10px] tabular-nums text-white/30">
                    {formatTime(tick.time)}
                  </span>
                )}
              </div>
            ))}

            {/* Playhead */}
            <div
              className="pointer-events-none absolute inset-y-0 z-10 w-px bg-white/80"
              style={{ left: `${playheadPercent}%` }}
            >
              <button
                type="button"
                className="pointer-events-auto absolute -top-0.5 left-1/2 h-2.5 w-2.5 -translate-x-1/2 cursor-ew-resize rounded-[3px] bg-white shadow-[0_0_10px_rgba(255,255,255,0.5)]"
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
        </div>

        {/* Track area */}
        <div
          ref={trackRef}
          className="relative mt-2 min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          onMouseDown={handleTrackAreaMouseDown}
          onClick={handleTrackClick}
        >
          <div className="relative min-h-full">
            <div className="grid" style={laneGridStyle}>
              {lanes.map((lane) => {
                const LaneIcon = laneIcons[lane.kind];

                return (
                  <div key={lane.id} className="contents">
                    <div
                      className="flex items-center gap-2 pr-3"
                      style={{ height: LANE_HEIGHT_PX }}
                    >
                      <span
                        className={cn(
                          'grid size-[24px] flex-none place-items-center rounded-[8px] bg-white/[0.06]',
                          regionAccentText[lane.kind],
                        )}
                      >
                        <LaneIcon size={12} />
                      </span>
                      <span className="grid min-w-0 gap-px">
                        <span
                          className={cn(
                            'text-[9px] font-[750] uppercase tracking-[0.1em]',
                            regionAccentText[lane.kind],
                          )}
                        >
                          {lane.typeLabel}
                        </span>
                        <strong className="truncate text-[11px] font-[650] text-white/75">
                          {lane.label}
                        </strong>
                      </span>
                      <span className="ml-auto text-[10px] tabular-nums text-white/25">
                        {lane.regionCount}
                      </span>
                    </div>

                    <div
                      className="relative overflow-hidden rounded-[12px] border border-white/[0.06] bg-white/[0.022]"
                      style={{ height: LANE_HEIGHT_PX }}
                      onDoubleClick={lane.onDoubleClick}
                    >
                      <TimelineFilmstrip sheet={lane.sheet} durationMs={duration} />

                      {lane.videoPath ? <TimelineWaveform videoPath={lane.videoPath} /> : null}

                      {lane.regionCount === 0 ? (
                        <span className="pointer-events-none absolute inset-0 grid place-items-center text-[10px] text-white/20">
                          {lane.emptyHint}
                        </span>
                      ) : null}

                      {lane.regions}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Playhead spans the full lane stack */}
            <div
              className="pointer-events-none absolute inset-y-0 right-0 z-30"
              style={{ left: LANE_GUTTER_PX }}
            >
              <div
                className="absolute inset-y-0 w-px bg-white/45"
                style={{ left: `${playheadPercent}%` }}
              />
            </div>

            {cutSelectionOverlayStyle && (
              <div
                className="pointer-events-none absolute z-40 rounded-[8px] border border-[#5eead4]/50 bg-emerald-400/10"
                style={cutSelectionOverlayStyle}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
