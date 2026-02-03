import { Download, FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { useEditor } from '../../../context/editor-context';
import { ExportModal } from './export-modal';

export function PropertiesPanel() {
  const { project, updateBackgroundColor } = useEditor();
  const [exportModalOpen, setExportModalOpen] = useState(false);

  if (!project) return null;

  const handleOpenExportsFolder = async () => {
    await window.electron.exporter.openExportsFolder();
  };

  return (
    <div className="p-4 space-y-6">
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-4 uppercase tracking-wider">
          Properties
        </h3>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="bg-color" className="text-sm font-medium">
              Canvas Background
            </label>
            <div className="flex gap-3 items-center">
              <input
                id="bg-color"
                type="color"
                value={project.backgroundColor || '#000000'}
                onChange={(e) => updateBackgroundColor(e.target.value)}
                className="h-9 w-12 p-0 border-0 rounded bg-transparent cursor-pointer"
              />
              <span className="text-xs font-mono text-muted-foreground">
                {project.backgroundColor || '#000000'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Export Section */}
      <div className="pt-4 border-t border-border">
        <h3 className="text-sm font-medium text-muted-foreground mb-4 uppercase tracking-wider">
          Export
        </h3>

        <div className="space-y-3">
          <Button onClick={() => setExportModalOpen(true)} className="w-full">
            <Download className="size-4" />
            Export Video
          </Button>

          <Button variant="outline" onClick={handleOpenExportsFolder} className="w-full">
            <FolderOpen className="size-4" />
            Open Exports Folder
          </Button>
        </div>
      </div>

      {/* Export Modal */}
      <ExportModal open={exportModalOpen} onOpenChange={setExportModalOpen} />
    </div>
  );
}
