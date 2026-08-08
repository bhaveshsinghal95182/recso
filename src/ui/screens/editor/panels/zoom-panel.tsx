/**
 * ZoomPanel — screen zoom regions only.
 *
 * Webcam zoom regions are edited in the webcam panel, so everything about the
 * webcam lives in one place. This panel therefore reads `zoomRegionsBySource.screen`
 * directly rather than the ambient `zoomRegions`, which follows the timeline's
 * current source and would otherwise swap this panel's contents underneath it.
 */

import { Check, Crosshair, Sparkles, Wand2, ZoomIn } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import CopyIcon from '@/components/icons/copy-icon';
import type { AnimatedIconHandle } from '@/components/icons/types';
import {
  DEFAULT_ZOOM_LEVEL,
  GROUP_THRESHOLD_MS,
  PRE_CLICK_LEAD_MS,
  ZOOM_DURATION_MS,
} from '@/constants';
import { smartPanSingleRegion } from '@/lib/calculations/pan';
import { useProjectStore } from '@/store/project-store';
import { useTimelineStore } from '@/store/timeline-store';
import type { RecordedMouseEvent, ZoomRegion } from '@/types';

import {
  ActionCard,
  PanelButton,
  PanelEmpty,
  PanelNote,
  PanelSection,
  PanelSlider,
} from './panel-kit';

const ZOOM_SOURCE = 'screen' as const;

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function resolveNormalizedEventCoordinates(
  event: RecordedMouseEvent,
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number } {
  if (typeof event.normalizedX === 'number' && typeof event.normalizedY === 'number') {
    return {
      x: clampUnit(event.normalizedX),
      y: clampUnit(event.normalizedY),
    };
  }

  return {
    x: clampUnit(event.x / Math.max(1, videoWidth)),
    y: clampUnit(event.y / Math.max(1, videoHeight)),
  };
}

export function ZoomPanel() {
  const { project } = useProjectStore();
  const {
    zoomRegionsBySource,
    selectedZoomId,
    updateZoom,
    updateZoomRegions,
    replaceZoomRegions,
    isEditingFocalPoint,
    setIsEditingFocalPoint,
  } = useTimelineStore();

  const zoomRegions = zoomRegionsBySource.screen;
  const selectedZoom = zoomRegions.find((zoom) => zoom.id === selectedZoomId);
  const copyIconRef = useRef<AnimatedIconHandle>(null);

  const [localZoomLevel, setLocalZoomLevel] = useState(
    selectedZoom?.zoomLevel ?? DEFAULT_ZOOM_LEVEL,
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (selectedZoom) {
      setLocalZoomLevel(selectedZoom.zoomLevel);
    }
  }, [selectedZoom?.id, selectedZoom?.zoomLevel]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const handleZoomLevelChange = useCallback(
    (level: number) => {
      if (!Number.isFinite(level) || level < 1 || level > 5) return;

      setLocalZoomLevel(level);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        if (selectedZoom) {
          void updateZoom({ ...selectedZoom, zoomLevel: level }, ZOOM_SOURCE);
        }
      }, 150);
    },
    [selectedZoom, updateZoom],
  );

  const handleApplyToAll = useCallback(() => {
    if (!selectedZoom || zoomRegions.length <= 1) return;

    const updatedZooms = zoomRegions
      .filter((zoom) => zoom.id !== selectedZoom.id)
      .map((zoom) => ({ ...zoom, zoomLevel: selectedZoom.zoomLevel }));

    void updateZoomRegions(updatedZooms, ZOOM_SOURCE);

    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  }, [selectedZoom, zoomRegions, updateZoomRegions]);

  /**
   * Apply smart panning to one or many zoom regions.
   * Adds focal-point keyframes that follow the mouse cursor
   * instead of splitting the region into many sub-regions.
   */
  const handleSmartPan = useCallback(async () => {
    if (!project) return;

    setIsPanning(true);

    try {
      const allEvents = await window.electron.editor.getMouseEvents();

      // Fall back to the last event when duration metadata is missing —
      // streamed WebM often reports duration 0.
      let videoDuration = project.timeline.duration;
      if (videoDuration <= 0 && allEvents.length > 0) {
        videoDuration = Math.max(...allEvents.map((event) => event.timestampMs)) + 5000;
      }

      const moves = allEvents
        .filter((event) => event.timestampMs <= videoDuration)
        .sort((a, b) => a.timestampMs - b.timestampMs);

      if (moves.length === 0) {
        setIsPanning(false);
        return;
      }

      const videoWidth = project.videoDimensions?.width || 1920;
      const videoHeight = project.videoDimensions?.height || 1080;

      const regionsToProcess = selectedZoom ? [selectedZoom] : [...zoomRegions];
      const updatedRegions: ZoomRegion[] = [];

      for (const region of regionsToProcess) {
        updatedRegions.push(smartPanSingleRegion(region, moves, videoWidth, videoHeight));
      }

      const processedIds = new Set(regionsToProcess.map((region) => region.id));
      const untouched = zoomRegions.filter((zoom) => !processedIds.has(zoom.id));
      const allRegions = [...untouched, ...updatedRegions].sort((a, b) => a.startMs - b.startMs);

      await replaceZoomRegions(allRegions, ZOOM_SOURCE);
    } catch {
      // Failed to smart pan
    } finally {
      setIsPanning(false);
    }
  }, [project, selectedZoom, zoomRegions, replaceZoomRegions]);

  /**
   * Generate zoom regions from recorded mouse click events.
   * Groups rapid clicks (within GROUP_THRESHOLD_MS) into single zoom regions.
   */
  const generateZoomsFromClicks = useCallback(async () => {
    if (!project) return;

    setIsGenerating(true);

    try {
      const events = await window.electron.editor.getMouseEvents();

      let videoDuration = project.timeline.duration;
      if (videoDuration <= 0 && events.length > 0) {
        videoDuration = Math.max(...events.map((event) => event.timestampMs)) + 5000;
      }

      const clicks = events
        .filter((event) => event.eventType === 'click' && event.timestampMs <= videoDuration)
        .sort((a, b) => a.timestampMs - b.timestampMs);

      if (clicks.length === 0) {
        setIsGenerating(false);
        return;
      }

      const videoWidth = project.videoDimensions?.width || 1920;
      const videoHeight = project.videoDimensions?.height || 1080;

      const newZooms: ZoomRegion[] = [];
      let currentRegion: ZoomRegion | null = null;
      let lastClickTime = 0;

      for (const click of clicks) {
        const timeSinceLastClick = click.timestampMs - lastClickTime;

        if (currentRegion && timeSinceLastClick < GROUP_THRESHOLD_MS) {
          // Rapid click — extend the region, keep the first click's focal point.
          currentRegion.endMs = Math.min(click.timestampMs + ZOOM_DURATION_MS, videoDuration);
        } else {
          if (currentRegion) {
            newZooms.push(currentRegion);
          }

          const { x: focalX, y: focalY } = resolveNormalizedEventCoordinates(
            click,
            videoWidth,
            videoHeight,
          );

          currentRegion = {
            id: crypto.randomUUID(),
            startMs: Math.max(0, click.timestampMs - PRE_CLICK_LEAD_MS),
            endMs: Math.min(click.timestampMs + ZOOM_DURATION_MS, videoDuration),
            zoomLevel: DEFAULT_ZOOM_LEVEL,
            focalX,
            focalY,
            easeDurationMs: 300,
          };
        }

        lastClickTime = click.timestampMs;
      }

      if (currentRegion) {
        newZooms.push(currentRegion);
      }

      await replaceZoomRegions(newZooms, ZOOM_SOURCE);
    } catch {
      // Failed to generate zooms
    } finally {
      setIsGenerating(false);
    }
  }, [project, replaceZoomRegions]);

  const automation = (
    <PanelSection title="Automate">
      <ActionCard
        Icon={Sparkles}
        title="Auto zoom"
        description="Create a zoom region around every mouse click, grouping rapid clicks together."
        actionLabel={isGenerating ? 'Generating…' : 'Generate from clicks'}
        disabled={isGenerating || !project}
        onAction={() => void generateZoomsFromClicks()}
      />

      <ActionCard
        Icon={Wand2}
        title="Smart pan"
        description={
          selectedZoom
            ? 'Follow the cursor inside this region instead of holding one focal point.'
            : 'Follow the cursor inside every zoom region instead of holding one focal point.'
        }
        actionLabel={isPanning ? 'Panning…' : 'Enable smart pan'}
        disabled={isPanning || !project || zoomRegions.length === 0}
        onAction={() => void handleSmartPan()}
      />
    </PanelSection>
  );

  if (!selectedZoom) {
    return (
      <>
        <PanelEmpty
          Icon={ZoomIn}
          title="No zoom region selected"
          hint="Pick one on the timeline, or double-click the screen zoom lane to add one."
        />
        {automation}
      </>
    );
  }

  return (
    <>
      <PanelSection title="Selected region">
        <PanelSlider
          label="Zoom level"
          value={localZoomLevel}
          min={1}
          max={5}
          step={0.1}
          onChange={handleZoomLevelChange}
          format={(value) => `${value.toFixed(1)}x`}
        />

        <PanelButton
          Icon={Crosshair}
          active={isEditingFocalPoint}
          onClick={() => setIsEditingFocalPoint(!isEditingFocalPoint)}
        >
          {isEditingFocalPoint ? 'Done editing focal point' : 'Edit focal point'}
        </PanelButton>

        {zoomRegions.length > 1 && (
          <PanelButton
            onClick={handleApplyToAll}
            onMouseEnter={() => copyIconRef.current?.startAnimation()}
            onMouseLeave={() => copyIconRef.current?.stopAnimation()}
          >
            <span className="relative size-4">
              <AnimatePresence mode="wait" initial={false}>
                {isCopied ? (
                  <motion.span
                    key="check"
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ duration: 0.2 }}
                    className="absolute inset-0 grid place-items-center"
                  >
                    <Check className="size-4 text-emerald-400" />
                  </motion.span>
                ) : (
                  <motion.span
                    key="copy"
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ duration: 0.2 }}
                    className="absolute inset-0 grid place-items-center"
                  >
                    <CopyIcon ref={copyIconRef} size={16} />
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
            Apply level to all {zoomRegions.length} regions
          </PanelButton>
        )}

        <PanelNote>Webcam zoom regions are edited in the Webcam panel.</PanelNote>
      </PanelSection>

      {automation}
    </>
  );
}
