import { Check } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AutoZoomButton } from '@/components/auto-zoom-button';
import Ai from '@/components/icons/ai-chip';
import CopyIcon from '@/components/icons/copy-icon';
import FocusIcon from '@/components/icons/focus-icon';
import type { AnimatedIconHandle } from '@/components/icons/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function clampWebcamHeightRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.34;
  }

  return Math.max(0.08, Math.min(0.75, value));
}

function resolveEffectiveWebcamHeightRatio(
  zoom: ZoomRegion | undefined,
  baseHeightRatio: number,
): number {
  if (!zoom) {
    return clampWebcamHeightRatio(baseHeightRatio);
  }

  if (typeof zoom.webcamHeightRatio === 'number' && Number.isFinite(zoom.webcamHeightRatio)) {
    return clampWebcamHeightRatio(zoom.webcamHeightRatio);
  }

  return clampWebcamHeightRatio(baseHeightRatio * Math.max(0.1, zoom.zoomLevel));
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
    zoomSource,
    zoomRegions,
    selectedZoomId,
    updateZoom,
    updateZoomRegions,
    replaceZoomRegions,
    isEditingFocalPoint,
    setIsEditingFocalPoint,
  } = useTimelineStore();

  const selectedZoom = zoomRegions.find((z) => z.id === selectedZoomId);
  const baseWebcamHeightRatio = clampWebcamHeightRatio(project?.webcamOverlay?.heightRatio ?? 0.34);
  const focusIconRef = useRef<AnimatedIconHandle>(null);
  const copyIconRef = useRef<AnimatedIconHandle>(null);

  // Local state for debounced slider
  const [localZoomLevel, setLocalZoomLevel] = useState(selectedZoom?.zoomLevel ?? 1.5);
  const [localWebcamHeightRatio, setLocalWebcamHeightRatio] = useState(() =>
    resolveEffectiveWebcamHeightRatio(selectedZoom, baseWebcamHeightRatio),
  );
  const [isWebcamFullScreen, setIsWebcamFullScreen] = useState(
    selectedZoom?.webcamFullScreen === true,
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webcamDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local state when selected zoom changes
  useEffect(() => {
    if (selectedZoom) {
      setLocalZoomLevel(selectedZoom.zoomLevel);
      setLocalWebcamHeightRatio(
        resolveEffectiveWebcamHeightRatio(selectedZoom, baseWebcamHeightRatio),
      );
      setIsWebcamFullScreen(selectedZoom.webcamFullScreen === true);
    }
  }, [
    selectedZoom?.id,
    selectedZoom?.zoomLevel,
    selectedZoom?.webcamHeightRatio,
    selectedZoom?.webcamFullScreen,
    baseWebcamHeightRatio,
  ]);

  // Debounced update handler
  const handleZoomLevelChange = useCallback(
    (value: string) => {
      const level = parseFloat(value);
      if (isNaN(level) || level < 1 || level > 5) return;

      // Update local state immediately for responsive UI
      setLocalZoomLevel(level);

      // Debounce the actual update
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        if (selectedZoom) {
          updateZoom({ ...selectedZoom, zoomLevel: level });
        }
      }, 150);
    },
    [selectedZoom, updateZoom],
  );

  // Debounced webcam height ratio handler
  const handleWebcamHeightRatioChange = useCallback(
    (value: string) => {
      if (isWebcamFullScreen) {
        return;
      }

      const ratio = parseFloat(value);
      if (isNaN(ratio) || ratio < 0.08 || ratio > 0.75) return;

      setLocalWebcamHeightRatio(ratio);

      if (webcamDebounceRef.current) {
        clearTimeout(webcamDebounceRef.current);
      }

      webcamDebounceRef.current = setTimeout(() => {
        if (selectedZoom) {
          updateZoom({ ...selectedZoom, webcamHeightRatio: ratio });
        }
      }, 150);
    },
    [isWebcamFullScreen, selectedZoom, updateZoom],
  );

  const handleWebcamFullScreenChange = useCallback(
    (checked: boolean) => {
      setIsWebcamFullScreen(checked);
      if (selectedZoom) {
        updateZoom({ ...selectedZoom, webcamFullScreen: checked });
      }
    },
    [selectedZoom, updateZoom],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (webcamDebounceRef.current) {
        clearTimeout(webcamDebounceRef.current);
      }
    };
  }, []);

  const handleApplyToAll = useCallback(() => {
    if (!selectedZoom || zoomRegions.length <= 1) return;

    const shouldApplyWebcamSettings = zoomSource === 'webcam';
    const webcamHeightRatioToApply = selectedZoom.webcamHeightRatio ?? localWebcamHeightRatio;
    const webcamFullScreenToApply = selectedZoom.webcamFullScreen ?? isWebcamFullScreen;

    // Build array of updated zoom regions
    const updatedZooms = zoomRegions
      .filter((z) => z.id !== selectedZoom.id)
      .map((z) => ({
        ...z,
        zoomLevel: selectedZoom.zoomLevel,
        ...(shouldApplyWebcamSettings
          ? {
              webcamHeightRatio: webcamHeightRatioToApply,
              webcamFullScreen: webcamFullScreenToApply,
            }
          : {}),
      }));

    // Use bulk update for efficiency
    updateZoomRegions(updatedZooms);

    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  }, [
    selectedZoom,
    zoomRegions,
    updateZoomRegions,
    zoomSource,
    localWebcamHeightRatio,
    isWebcamFullScreen,
  ]);

  /**
   * Apply smart panning to one or many zoom regions.
   * Adds focal-point keyframes that follow the mouse cursor
   * instead of splitting the region into many sub-regions.
   */
  const handleSmartPan = useCallback(async () => {
    if (!project) return;

    setIsPanning(true);

    try {
      // 1. Fetch ALL mouse events (moves + clicks)
      const allEvents = await window.electron.editor.getMouseEvents();

      // Get video duration — fall back to max event timestamp if duration is 0
      // (WebM files written via streaming MediaRecorder often have duration=0 in metadata)
      let videoDuration = project.timeline.duration;
      if (videoDuration <= 0 && allEvents.length > 0) {
        videoDuration = Math.max(...allEvents.map((e) => e.timestampMs)) + 5000;
      }

      // Filter to moves within video duration
      const moves = allEvents
        .filter((e) => e.timestampMs <= videoDuration)
        .sort((a, b) => a.timestampMs - b.timestampMs);

      if (moves.length === 0) {
        setIsPanning(false);
        return;
      }

      const videoWidth = project.videoDimensions?.width || 1920;
      const videoHeight = project.videoDimensions?.height || 1080;

      // 2. Determine which regions to process
      const regionsToProcess = selectedZoom ? [selectedZoom] : [...zoomRegions];

      // 3. Process each region → add focalKeyframes (no splitting)
      const updatedRegions: ZoomRegion[] = [];

      for (const region of regionsToProcess) {
        const updated = smartPanSingleRegion(region, moves, videoWidth, videoHeight);
        updatedRegions.push(updated);
      }

      // 4. Merge updated regions back with untouched ones
      const processedIds = new Set(regionsToProcess.map((r) => r.id));
      const untouched = zoomRegions.filter((z) => !processedIds.has(z.id));

      const allRegions = [...untouched, ...updatedRegions].sort((a, b) => a.startMs - b.startMs);

      // Full state replacement (syncs to backend and updates local state)
      await replaceZoomRegions(allRegions);
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
    if (!project || zoomSource !== 'screen') return;

    setIsGenerating(true);

    try {
      // Fetch mouse events from backend
      const events = await window.electron.editor.getMouseEvents();

      // Get video duration — fall back to max event timestamp if duration is 0
      // (WebM files written via streaming MediaRecorder often have duration=0 in metadata)
      let videoDuration = project.timeline.duration;
      if (videoDuration <= 0 && events.length > 0) {
        videoDuration = Math.max(...events.map((e) => e.timestampMs)) + 5000;
      }

      // Filter for clicks only, exclude clicks past video duration, and sort by time
      const clicks = events
        .filter((e) => e.eventType === 'click' && e.timestampMs <= videoDuration)
        .sort((a, b) => a.timestampMs - b.timestampMs);

      if (clicks.length === 0) {
        setIsGenerating(false);
        return;
      }

      // Get video dimensions for normalizing coordinates
      const videoWidth = project.videoDimensions?.width || 1920;
      const videoHeight = project.videoDimensions?.height || 1080;

      // Generate zoom regions by grouping rapid clicks
      const newZooms: ZoomRegion[] = [];
      let currentRegion: ZoomRegion | null = null;
      let lastClickTime = 0;

      for (const click of clicks) {
        const timeSinceLastClick = click.timestampMs - lastClickTime;

        if (currentRegion && timeSinceLastClick < GROUP_THRESHOLD_MS) {
          // Extend current region - rapid click detected

          // Clamp endMs to video duration
          currentRegion.endMs = Math.min(click.timestampMs + ZOOM_DURATION_MS, videoDuration);
          // Keep focal point at first click's location
        } else {
          // Create new region
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

      // Don't forget the last region
      if (currentRegion) {
        newZooms.push(currentRegion);
      }

      // Replace all zoom regions with the generated ones (preserves focal points)
      await replaceZoomRegions(newZooms, 'screen');
    } catch {
      // Failed to generate zooms
    } finally {
      setIsGenerating(false);
    }
  }, [project, replaceZoomRegions, zoomSource]);

  const smartPanButton = (
    <Card className="p-4 shadow-sm border-2 border-brand/20 bg-linear-to-br from-brand-dark/10 to-transparent gap-2">
      <div className="flex items-center gap-3">
        <div className="bg-brand/20 text-brand-light p-2 rounded-lg flex items-center justify-center shrink-0 shadow-[0_0_10px_rgba(16,185,129,0.2)]">
          <Ai size="24" />
        </div>
        <h3 className="font-semibold text-base text-brand-light">Smart Pan</h3>
      </div>

      <p className="text-sm text-muted-foreground leading-relaxed mt-2 mb-4">
        Automatically follows the mouse cursor or active window region within the zoomed area.
      </p>

      <Button
        className="w-full font-bold tracking-wide uppercase text-xs h-10 bg-brand/10 text-brand-light border-brand/30 hover:bg-brand/20 hover:border-brand/50 hover:text-white transition-all duration-300 shadow-[0_0_10px_rgba(16,185,129,0.1)] hover:shadow-[0_0_15px_rgba(16,185,129,0.2)]"
        onClick={handleSmartPan}
        disabled={isPanning || !project || zoomRegions.length === 0}
        variant={'outline'}
      >
        {isPanning ? 'Panning...' : 'Enable Smart Pan'}
      </Button>
    </Card>
  );

  if (!selectedZoom) {
    return (
      <div className="space-y-4">
        {/* Smart Pan button - global mode */}
        {zoomRegions.length > 0 && smartPanButton}

        {zoomSource === 'screen' && (
          <div className="pt-4 h-full ">
            <AutoZoomButton
              generateZoomsFromClicks={generateZoomsFromClicks}
              isGenerating={isGenerating}
              project={project}
            />
          </div>
        )}

        {zoomSource === 'webcam' && (
          <p className="pt-2 text-xs text-muted-foreground">
            Auto Zoom creates regions for screen recording only. Switch the zoom source to screen to
            generate auto zooms.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="zoom-level">Zoom Level</Label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            id="zoom-level-slider"
            min="1"
            max="5"
            step="0.1"
            value={localZoomLevel}
            onChange={(e) => handleZoomLevelChange(e.target.value)}
            className="flex-1"
          />
          <Input
            id="zoom-level"
            type="number"
            min="1"
            max="5"
            step="0.1"
            value={localZoomLevel}
            onChange={(e) => handleZoomLevelChange(e.target.value)}
            className="w-20 font-mono text-xs h-8"
          />
        </div>
      </div>

      {zoomSource === 'webcam' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div className="space-y-1">
              <Label htmlFor="webcam-full-screen" className="text-sm">
                Full Canvas Webcam
              </Label>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Use webcam as the full frame for this timeline region.
              </p>
            </div>
            <Switch
              id="webcam-full-screen"
              checked={isWebcamFullScreen}
              onCheckedChange={handleWebcamFullScreenChange}
            />
          </div>

          <Label htmlFor="webcam-height-ratio">Webcam Canvas Height</Label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              id="webcam-height-ratio-slider"
              min="0.08"
              max="0.75"
              step="0.01"
              value={localWebcamHeightRatio}
              onChange={(e) => handleWebcamHeightRatioChange(e.target.value)}
              disabled={isWebcamFullScreen}
              className="flex-1"
            />
            <Input
              id="webcam-height-ratio"
              type="number"
              min="0.08"
              max="0.75"
              step="0.01"
              value={localWebcamHeightRatio}
              onChange={(e) => handleWebcamHeightRatioChange(e.target.value)}
              disabled={isWebcamFullScreen}
              className="w-20 font-mono text-xs h-8"
            />
          </div>
          <p className="text-[11px] text-muted-foreground leading-snug">
            {isWebcamFullScreen
              ? 'Full-canvas mode is active for this region.'
              : 'Controls the webcam overlay size within this region (0.08 - 0.75).'}
          </p>
        </div>
      )}

      {zoomRegions.length > 1 && (
        <div className="pt-2">
          <Button
            variant="outline"
            onClick={handleApplyToAll}
            onMouseEnter={() => copyIconRef.current?.startAnimation()}
            onMouseLeave={() => copyIconRef.current?.stopAnimation()}
            className="w-full"
          >
            {/* <Copy className="size-4 mr-2" /> */}
            <div className="relative size-4 mr-2">
              <AnimatePresence mode="wait" initial={false}>
                {isCopied ? (
                  <motion.div
                    key="check"
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ duration: 0.2 }}
                    className="absolute inset-0 flex items-center justify-center"
                  >
                    <Check className="size-4 text-green-500" />
                  </motion.div>
                ) : (
                  <motion.div
                    key="copy"
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ duration: 0.2 }}
                    className="absolute inset-0 flex items-center justify-center"
                  >
                    <CopyIcon ref={copyIconRef} size={16} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            Apply to All ({zoomRegions.length} regions)
          </Button>
        </div>
      )}

      {/* Edit Focal Point button */}
      <div
        className="pt-2"
        onMouseEnter={() => focusIconRef.current?.startAnimation()}
        onMouseLeave={() => focusIconRef.current?.stopAnimation()}
      >
        <Button
          variant={isEditingFocalPoint ? 'default' : 'outline'}
          onClick={() => setIsEditingFocalPoint(!isEditingFocalPoint)}
          className="w-full"
        >
          <FocusIcon className="size-4 mr-2" ref={focusIconRef} />
          {isEditingFocalPoint ? 'Done Editing' : 'Edit Focal Point'}
        </Button>
      </div>

      {/* Smart Pan button - local mode (selected region) */}
      {smartPanButton}

      {zoomSource === 'screen' && (
        <div className="pt-4 border-t border-border">
          <AutoZoomButton
            generateZoomsFromClicks={generateZoomsFromClicks}
            isGenerating={isGenerating}
            project={project}
          />
        </div>
      )}

      {zoomSource === 'webcam' && (
        <p className="pt-4 text-xs text-muted-foreground border-t border-border">
          Auto Zoom creates regions for screen recording only. Switch the zoom source to screen to
          generate auto zooms.
        </p>
      )}
    </div>
  );
}
