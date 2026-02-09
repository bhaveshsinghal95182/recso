import { Copy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useEditor } from '../../../../context/editor-context';

export function ZoomPanel() {
  const { zoomRegions, selectedZoomId, updateZoom, updateZoomRegions } = useEditor();

  const selectedZoom = zoomRegions.find((z) => z.id === selectedZoomId);

  // Local state for debounced slider
  const [localZoomLevel, setLocalZoomLevel] = useState(selectedZoom?.zoomLevel ?? 1.5);
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

  if (!selectedZoom) {
    return (
      <div className="flex items-center justify-center h-fit text-sm text-muted-foreground">
        Select a zoom region on the timeline to edit its settings.
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
        <div className="pt-4 border-t border-border">
          <Button variant="outline" onClick={handleApplyToAll} className="w-full">
            <Copy className="size-4 mr-2" />
            Apply to All ({zoomRegions.length} regions)
          </Button>
        </div>
      )}
    </div>
  );
}
