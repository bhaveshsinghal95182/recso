import { Copy, Crosshair, MousePointerClick } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AutoZoomButton } from '@/components/auto-zoom-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DEFAULT_ZOOM_LEVEL,
  GROUP_THRESHOLD_MS,
  PRE_CLICK_LEAD_MS,
  ZOOM_DURATION_MS,
} from '@/constants';
import { smartPanSingleRegion } from '@/lib/calculations/pan';
import { useProjectStore } from '@/store/project-store';
import { useTimelineStore } from '@/store/timeline-store';
import type { ZoomRegion } from '@/types';

export function ZoomPanel() {
  const { project } = useProjectStore();
  const {
    zoomRegions,
    selectedZoomId,
    updateZoom,
    updateZoomRegions,
    replaceZoomRegions,
    isEditingFocalPoint,
    setIsEditingFocalPoint,
  } = useTimelineStore();

  const selectedZoom = zoomRegions.find((z) => z.id === selectedZoomId);

  // Local state for debounced slider
  const [localZoomLevel, setLocalZoomLevel] = useState(selectedZoom?.zoomLevel ?? 1.5);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local state when selected zoom changes
  useEffect(() => {
    if (selectedZoom) {
      setLocalZoomLevel(selectedZoom.zoomLevel);
    }
  }, [selectedZoom?.id, selectedZoom?.zoomLevel]);

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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const handleApplyToAll = useCallback(() => {
    if (!selectedZoom || zoomRegions.length <= 1) return;

    // Build array of updated zoom regions
    const updatedZooms = zoomRegions
      .filter((z) => z.id !== selectedZoom.id)
      .map((z) => ({ ...z, zoomLevel: selectedZoom.zoomLevel }));

    // Use bulk update for efficiency
    updateZoomRegions(updatedZooms);
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
      // 1. Fetch ALL mouse events (moves + clicks)
      const allEvents = await window.electron.editor.getMouseEvents();
      const videoDuration = project.timeline.duration;

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
    } catch (error) {
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
      // Fetch mouse events from backend
      const events = await window.electron.editor.getMouseEvents();

      // Get video duration to filter out clicks past the end
      const videoDuration = project.timeline.duration;

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

          // Normalize coordinates to 0-1 range
          const focalX = Math.max(0, Math.min(1, click.x / videoWidth));
          const focalY = Math.max(0, Math.min(1, click.y / videoHeight));

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
      await replaceZoomRegions(newZooms);
    } catch (error) {
      // Failed to generate zooms
    } finally {
      setIsGenerating(false);
    }
  }, [project, replaceZoomRegions]);

  const smartPanButton = (
    <div className="pt-4 border-t border-border">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            onClick={handleSmartPan}
            disabled={isPanning || !project || zoomRegions.length === 0}
            className="w-full"
          >
            <MousePointerClick className="size-4 mr-2" />
            {isPanning
              ? 'Panning...'
              : selectedZoom
                ? 'Smart Pan This Region'
                : `Smart Pan All (${zoomRegions.length})`}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="">
            {selectedZoom
              ? 'Splits current region to follow the mouse cursor'
              : 'Splits all zoom regions to follow the mouse cursor'}
          </p>
        </TooltipContent>
      </Tooltip>
    </div>
  );

  if (!selectedZoom) {
    return (
      <div className="space-y-4">
        {/* Smart Pan button - global mode */}
        {zoomRegions.length > 0 && smartPanButton}

        {/* Generate Auto-Zooms button - always visible */}
        <div className="pt-4 h-full ">
          <AutoZoomButton
            generateZoomsFromClicks={generateZoomsFromClicks}
            isGenerating={isGenerating}
            project={project}
          />
        </div>
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

      {zoomRegions.length > 1 && (
        <div className="pt-2">
          <Button variant="outline" onClick={handleApplyToAll} className="w-full">
            <Copy className="size-4 mr-2" />
            Apply to All ({zoomRegions.length} regions)
          </Button>
        </div>
      )}

      {/* Edit Focal Point button */}
      <div className="pt-2">
        <Button
          variant={isEditingFocalPoint ? 'default' : 'outline'}
          onClick={() => setIsEditingFocalPoint(!isEditingFocalPoint)}
          className="w-full"
        >
          <Crosshair className="size-4 mr-2" />
          {isEditingFocalPoint ? 'Done Editing' : 'Edit Focal Point'}
        </Button>
      </div>

      {/* Smart Pan button - local mode (selected region) */}
      {smartPanButton}

      {/* Generate Auto-Zooms button */}
      <div className="pt-4 border-t border-border">
        <AutoZoomButton
          generateZoomsFromClicks={generateZoomsFromClicks}
          isGenerating={isGenerating}
          project={project}
        />
      </div>
    </div>
  );
}
