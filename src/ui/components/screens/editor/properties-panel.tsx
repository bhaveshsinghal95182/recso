import { Download, FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { CursorPanel } from './panels/cursor-panel';
import { GeneralPanel } from './panels/general-panel';
import { useEditor } from '../../../context/editor-context';
import { ExportModal } from './export-modal';

export function PropertiesPanel() {
  const { project, activePropertiesTab } = useEditor();
  const [exportModalOpen, setExportModalOpen] = useState(false);

  if (!project) return null;

  const handleOpenExportsFolder = async () => {
    await window.electron.exporter.openExportsFolder();
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
        {activePropertiesTab === 'general' && <GeneralPanel />}

        {/* Cursor Tab */}
        {activePropertiesTab === 'cursor' && <CursorPanel />}
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
