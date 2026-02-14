import { Download, FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useProjectStore } from '@/store/project-store';
import { useUIStore } from '@/store/ui-store';

import { GeneralPanel } from './panels/general-panel';
import { ZoomPanel } from './panels/zoom-panel';
import { ExportModal } from './export-modal';

export function PropertiesPanel() {
  const { project } = useProjectStore();
  const { activePropertiesTab } = useUIStore();
  const [exportModalOpen, setExportModalOpen] = useState(false);

  if (!project) return null;

  const handleOpenExportsFolder = async () => {
    await window.electron.exporter.openExportsFolder();
  };

  // Tab title mapping
  const tabTitles: Record<typeof activePropertiesTab, string> = {
    general: 'General',
    zoom: 'Zoom',
    export: 'Export',
  };

  return (
    <div className="p-4 space-y-6 flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <h3 className="text-sm font-medium text-muted-foreground mb-4 uppercase tracking-wider">
          {tabTitles[activePropertiesTab]}
        </h3>

        {/* General Tab */}
        {activePropertiesTab === 'general' && <GeneralPanel />}

        {/* Zoom Tab */}
        {activePropertiesTab === 'zoom' && <ZoomPanel />}
      </div>

      {/* Export buttons - always at bottom */}
      <div className="pt-4 border-t border-border space-y-3 gap-2 flex justify-between w-full">
        <Button onClick={() => setExportModalOpen(true)} className="w-5/6">
          <Download className="size-4" />
          Export
        </Button>

        <Button variant="outline" onClick={handleOpenExportsFolder} className="w-1/6">
          <FolderOpen className="size-4" />
        </Button>
      </div>

      {/* Export Modal */}
      <ExportModal open={exportModalOpen} onOpenChange={setExportModalOpen} />
    </div>
  );
}
