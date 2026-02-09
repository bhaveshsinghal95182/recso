import { Copy, Crosshair, MousePointerClick, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useEditor } from '../../../../context/editor-context';
import type { RecordedMouseEvent, ZoomRegion } from '../../../../types';

// Constants for auto-zoom generation
const GROUP_THRESHOLD_MS = 3000; // Max time between clicks to consider them part of the same action
const ZOOM_DURATION_MS = 2000; // Duration to hold zoom after the last click in a group
const PRE_CLICK_LEAD_MS = 500; // Start zooming slightly before the click
const DEFAULT_ZOOM_LEVEL = 1.5;

// Constants for smart pan
/** Minimum time a sub-region must last before we allow another split (ms) */
const MIN_REGION_DURATION_MS = 200;
/** Padding inside viewport edge — pan triggers when mouse is within this fraction of the edge */
const VIEWPORT_PADDING = 0.05;

/**
 * Given a zoom region and a set of mouse-move events, split the region into
 * sub-regions whenever the mouse leaves the visible viewport.
 *
 * Viewport math:
 *   At zoomLevel `z` with focal point `(fx, fy)` (both 0-1),
 *   the visible rectangle in normalised coords is:
 *     halfW = 0.5 / z
 *     halfH = 0.5 / z
 *     left  = fx - halfW,  right  = fx + halfW
 *     top   = fy - halfH,  bottom = fy + halfH
 *
 *   When the mouse (mx, my) moves outside this rect (with VIEWPORT_PADDING)
 *   we end the current sub-region and start a new one centred on the mouse.
 */
function smartPanSingleRegion(
  region: ZoomRegion,
  moves: RecordedMouseEvent[],
  videoWidth: number,
  videoHeight: number,
): ZoomRegion[] {
  // Filter moves that fall within this region's time span
  const regionMoves = moves.filter(
    (m) => m.timestampMs >= region.startMs && m.timestampMs <= region.endMs,
  );

  if (regionMoves.length === 0) return [region];

  const results: ZoomRegion[] = [];
  let current: ZoomRegion = { ...region, id: crypto.randomUUID() };

  for (const move of regionMoves) {
    const z = current.zoomLevel;
    const halfW = 0.5 / z;
    const halfH = 0.5 / z;

    // Padded viewport bounds (trigger pan slightly before the actual edge)
    const left = current.focalX - halfW + VIEWPORT_PADDING;
    const right = current.focalX + halfW - VIEWPORT_PADDING;
    const top = current.focalY - halfH + VIEWPORT_PADDING;
    const bottom = current.focalY + halfH - VIEWPORT_PADDING;

    // Normalise mouse position to 0-1
    const mx = move.x / videoWidth;
    const my = move.y / videoHeight;

    const outOfFrame = mx < left || mx > right || my < top || my > bottom;

    if (outOfFrame) {
      // Ensure current sub-region has a minimum duration
      const elapsed = move.timestampMs - current.startMs;
      if (elapsed < MIN_REGION_DURATION_MS) continue;

      // Close current region at this timestamp
      current.endMs = move.timestampMs;
      results.push(current);

      // Open a new region centred on the mouse position (clamped to 0-1)
      current = {
        id: crypto.randomUUID(),
        startMs: move.timestampMs,
        endMs: region.endMs,
        zoomLevel: region.zoomLevel,
        focalX: Math.max(0, Math.min(1, mx)),
        focalY: Math.max(0, Math.min(1, my)),
        easeDurationMs: region.easeDurationMs,
      };
    }
  }

  // Push the final sub-region
  results.push(current);
  return results;
}

export function ZoomPanel() {
  const {
    project,
    zoomRegions,
    selectedZoomId,
    addZoom,
    updateZoom,
    updateZoomRegions,
    replaceZoomRegions,
    isEditingFocalPoint,
    setIsEditingFocalPoint,
  } = useEditor();

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
   * If `selectedZoom` is set, only that region is processed.
   * Otherwise all regions are processed.
   */
  const handleSmartPan = useCallback(async () => {
    if (!project) return;

    setIsPanning(true);

    try {
      // 1. Fetch ALL mouse events (moves + clicks)
      const allEvents = await window.electron.editor.getMouseEvents();
      const videoDuration = project.timeline.duration;

      // Filter to moves within video duration (clicks not needed for pan detection)
      const moves = allEvents
        .filter((e) => e.timestampMs <= videoDuration)
        .sort((a, b) => a.timestampMs - b.timestampMs);

      if (moves.length === 0) {
        console.log('[SmartPan] No mouse events found');
        setIsPanning(false);
        return;
      }

      const videoWidth = project.videoDimensions?.width || 1920;
      const videoHeight = project.videoDimensions?.height || 1080;

      // 2. Determine which regions to process
      const regionsToProcess = selectedZoom ? [selectedZoom] : [...zoomRegions];
      const untouchedRegions = selectedZoom
        ? zoomRegions.filter((z) => z.id !== selectedZoom.id)
        : [];

      console.log(
        `[SmartPan] Processing ${regionsToProcess.length} region(s) with ${moves.length} mouse events`,
      );

      // 3. Process each region → split into sub-regions
      const newRegions: ZoomRegion[] = [];
      const idsToRemove: string[] = [];

      for (const region of regionsToProcess) {
        const subRegions = smartPanSingleRegion(region, moves, videoWidth, videoHeight);
        console.log(
          `[SmartPan] Region ${region.id} (${region.startMs}-${region.endMs}ms) → ${subRegions.length} sub-region(s)`,
        );
        idsToRemove.push(region.id);
        newRegions.push(...subRegions);
      }

      // 4. Build final array and do a full replacement
      const allNewRegions = [...untouchedRegions, ...newRegions].sort(
        (a, b) => a.startMs - b.startMs,
      );

      // Full state replacement (syncs to backend and updates local state)
      await replaceZoomRegions(allNewRegions);

      console.log(
        `[SmartPan] Done. Replaced ${idsToRemove.length} region(s) with ${newRegions.length} sub-region(s)`,
      );
    } catch (error) {
      console.error('[SmartPan] Failed:', error);
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
      console.log('[ZoomPanel] Fetching mouse events...');
      // Fetch mouse events from backend
      const events = await window.electron.editor.getMouseEvents();
      console.log(`[ZoomPanel] Fetched ${events.length} total events`);

      // Get video duration to filter out clicks past the end
      const videoDuration = project.timeline.duration;
      console.log(`[ZoomPanel] Video duration: ${videoDuration}ms`);

      // Filter for clicks only, exclude clicks past video duration, and sort by time
      const clicks = events
        .filter((e) => e.eventType === 'click' && e.timestampMs <= videoDuration)
        .sort((a, b) => a.timestampMs - b.timestampMs);

      console.log(`[ZoomPanel] Found ${clicks.length} valid click events (within video duration)`);

      if (clicks.length === 0) {
        console.log('[ZoomPanel] No click events found within video duration');
        setIsGenerating(false);
        return;
      }

      // Get video dimensions for normalizing coordinates
      const videoWidth = project.videoDimensions?.width || 1920;
      const videoHeight = project.videoDimensions?.height || 1080;
      console.log(`[ZoomPanel] Using video dimensions: ${videoWidth}x${videoHeight}`);

      // Generate zoom regions by grouping rapid clicks
      const newZooms: ZoomRegion[] = [];
      let currentRegion: ZoomRegion | null = null;
      let lastClickTime = 0;

      for (const click of clicks) {
        const timeSinceLastClick = click.timestampMs - lastClickTime;

        if (currentRegion && timeSinceLastClick < GROUP_THRESHOLD_MS) {
          // Extend current region - rapid click detected
          console.log(
            `[ZoomPanel] Extending region for click at ${click.timestampMs}ms (diff: ${timeSinceLastClick}ms)`,
          );
          // Clamp endMs to video duration
          currentRegion.endMs = Math.min(click.timestampMs + ZOOM_DURATION_MS, videoDuration);
          // Keep focal point at first click's location
        } else {
          // Create new region
          if (currentRegion) {
            newZooms.push(currentRegion);
            console.log(
              `[ZoomPanel] Finalized region ${currentRegion.id} (${currentRegion.startMs}-${currentRegion.endMs}ms)`,
            );
          }

          // Normalize coordinates to 0-1 range
          const focalX = Math.max(0, Math.min(1, click.x / videoWidth));
          const focalY = Math.max(0, Math.min(1, click.y / videoHeight));

          console.log(
            `[ZoomPanel] Creating new region for click at ${click.timestampMs}ms at (${click.x}, ${click.y}) -> (${focalX.toFixed(3)}, ${focalY.toFixed(3)})`,
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

      // Add all new zoom regions
      for (const zoom of newZooms) {
        await addZoom(zoom.startMs, zoom.endMs);
      }

      console.log(
        `[ZoomPanel] Generated ${newZooms.length} zoom regions from ${clicks.length} clicks`,
      );
    } catch (error) {
      console.error('[ZoomPanel] Failed to generate zooms:', error);
    } finally {
      setIsGenerating(false);
    }
  }, [project, addZoom]);

  const smartPanButton = (
    <div className="pt-4 border-t border-border">
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
      <p className="text-xs text-muted-foreground mt-2 text-center">
        {selectedZoom
          ? 'Splits this region to follow the mouse cursor'
          : 'Splits all zoom regions to follow the mouse cursor'}
      </p>
    </div>
  );

  if (!selectedZoom) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-center h-fit text-sm text-muted-foreground">
          Select a zoom region on the timeline to edit its settings.
        </div>

        {/* Smart Pan button - global mode */}
        {zoomRegions.length > 0 && smartPanButton}

        {/* Generate Auto-Zooms button - always visible */}
        <div className="pt-4 border-t border-border">
          <Button
            variant="outline"
            onClick={generateZoomsFromClicks}
            disabled={isGenerating || !project}
            className="w-full"
          >
            <Zap className="size-4 mr-2" />
            {isGenerating ? 'Generating...' : 'Generate Auto-Zooms'}
          </Button>
          <p className="text-xs text-muted-foreground mt-2 text-center">
            Creates zoom regions for each mouse click
          </p>
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
        <Button
          variant="outline"
          onClick={generateZoomsFromClicks}
          disabled={isGenerating || !project}
          className="w-full"
        >
          <Zap className="size-4 mr-2" />
          {isGenerating ? 'Generating...' : 'Generate Auto-Zooms'}
        </Button>
        <p className="text-xs text-muted-foreground mt-2 text-center">
          Creates zoom regions for each mouse click
        </p>
      </div>
    </div>
  );
}
