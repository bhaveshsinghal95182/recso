import { Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useEditor } from '../../../../context/editor-context';

export function ZoomPanel() {
  const { zoomRegions, selectedZoomId, updateZoom } = useEditor();

  const selectedZoom = zoomRegions.find((z) => z.id === selectedZoomId);

  if (!selectedZoom) {
    return (
      <div className="flex items-center justify-center h-fit text-sm text-muted-foreground">
        Select a zoom region on the timeline to edit its settings.
      </div>
    );
  }

  const handleZoomLevelChange = (value: string) => {
    const level = parseFloat(value);
    if (!isNaN(level) && level >= 1 && level <= 5) {
      updateZoom({ ...selectedZoom, zoomLevel: level });
    }
  };

  const handleApplyToAll = () => {
    zoomRegions.forEach((z) => {
      if (z.id !== selectedZoom.id) {
        updateZoom({ ...z, zoomLevel: selectedZoom.zoomLevel });
      }
    });
  };

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
            value={selectedZoom.zoomLevel}
            onChange={(e) => handleZoomLevelChange(e.target.value)}
            className="flex-1"
          />
          <Input
            id="zoom-level"
            type="number"
            min="1"
            max="5"
            step="0.1"
            value={selectedZoom.zoomLevel}
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
