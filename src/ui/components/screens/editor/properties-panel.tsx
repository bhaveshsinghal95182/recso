import { Download, FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { useEditor } from '../../../context/editor-context';
import BloomColorPicker from '../../bloom-color-picker';
import { ExportModal } from './export-modal';

export function PropertiesPanel() {
  const { project, updateBackgroundColor, activePropertiesTab, updateCursorConfig } = useEditor();
  const [exportModalOpen, setExportModalOpen] = useState(false);

  if (!project) return null;

  const handleOpenExportsFolder = async () => {
    await window.electron.exporter.openExportsFolder();
  };

  // Cursor config
  const cursor = project.cursorConfig;
  const onCursorChange = (patch: Partial<typeof cursor>) => {
    updateCursorConfig(patch);
  };

  // Tab title mapping
  const tabTitles: Record<typeof activePropertiesTab, string> = {
    general: 'General',
    cursor: 'Cursor',
    export: 'Export',
  };

  return (
    <div className="p-4 space-y-6 flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <h3 className="text-sm font-medium text-muted-foreground mb-4 uppercase tracking-wider">
          {tabTitles[activePropertiesTab]}
        </h3>

        {/* General Tab */}
        {activePropertiesTab === 'general' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="bg-color" className="text-sm font-medium">
                Canvas Background
              </label>
              <div className="flex flex-col gap-4">
                <div className="flex justify-center py-4">
                  <BloomColorPicker
                    color={project.backgroundColor || '#000000'}
                    onChange={updateBackgroundColor}
                    stagger
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-12">Hex</span>
                  <Input
                    value={project.backgroundColor || '#000000'}
                    onChange={(e) => updateBackgroundColor(e.target.value)}
                    className="font-mono text-xs h-8"
                    placeholder="#000000"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Cursor Tab */}
        {activePropertiesTab === 'cursor' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Cursor Size</label>
              <input
                type="range"
                min={0.5}
                max={3}
                step={0.1}
                value={cursor.size}
                onChange={(e) => onCursorChange({ size: parseFloat(e.target.value) })}
                className="w-full accent-primary"
              />
              <div className="text-xs text-muted-foreground font-mono">
                {cursor.size.toFixed(1)}×
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Style</label>
              <select
                value={cursor.style}
                onChange={(e) => onCursorChange({ style: e.target.value as typeof cursor.style })}
                className="w-full p-2 rounded border border-border bg-card text-sm"
              >
                <option value="default">Default</option>
                <option value="pointer">Pointer</option>
                <option value="crosshair">Crosshair</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="show-click"
                type="checkbox"
                checked={cursor.showClickAnimations}
                onChange={(e) => onCursorChange({ showClickAnimations: e.target.checked })}
                className="accent-primary"
              />
              <label htmlFor="show-click" className="text-sm">
                Show Click Animations
              </label>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Click Scale</label>
              <input
                type="number"
                min={0.5}
                max={4}
                step={0.1}
                value={cursor.clickAnimationScale}
                onChange={(e) =>
                  onCursorChange({ clickAnimationScale: parseFloat(e.target.value) })
                }
                className="w-full p-2 rounded border border-border bg-card text-sm"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Click Duration (ms)</label>
              <input
                type="number"
                min={50}
                max={2000}
                step={10}
                value={cursor.clickDisplayDuration}
                onChange={(e) =>
                  onCursorChange({ clickDisplayDuration: parseInt(e.target.value, 10) })
                }
                className="w-full p-2 rounded border border-border bg-card text-sm"
              />
            </div>
          </div>
        )}
      </div>

      {/* Export buttons - always at bottom */}
      <div className="pt-4 border-t border-border space-y-3">
        <Button onClick={() => setExportModalOpen(true)} className="w-full">
          <Download className="size-4" />
          Export Video
        </Button>

        <Button variant="outline" onClick={handleOpenExportsFolder} className="w-full">
          <FolderOpen className="size-4" />
          Open Exports Folder
        </Button>
      </div>

      {/* Export Modal */}
      <ExportModal open={exportModalOpen} onOpenChange={setExportModalOpen} />
    </div>
  );
}
