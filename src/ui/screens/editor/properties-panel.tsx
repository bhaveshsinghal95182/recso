import { Download, FolderOpen } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useExportStore } from '@/store/export-store';
import { useProjectStore } from '@/store/project-store';
import { useUIStore } from '@/store/ui-store';

import { CursorPanel } from './panels/cursor-panel';
import { GeneralPanel } from './panels/general-panel';
import { PatternImportPanel } from './panels/pattern-import-panel';
import { WebcamPanel } from './panels/webcam-panel';
import { ZoomPanel } from './panels/zoom-panel';
import { ExportModal } from './export-modal';

export function PropertiesPanel() {
  const { project } = useProjectStore();
  const { activePropertiesTab } = useUIStore();
  const { isModalOpen, setModalOpen } = useExportStore();

  if (!project) return null;

  const handleOpenExportsFolder = async () => {
    await window.electron.exporter.openExportsFolder();
  };

  // Tab title mapping
  const tabTitles: Record<typeof activePropertiesTab, string> = {
    general: 'General',
    webcam: 'Webcam',
    cursor: 'Cursor',
    pattern: 'Pattern',
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

        {/* Webcam Tab */}
        {activePropertiesTab === 'webcam' && <WebcamPanel />}

        {/* Cursor Tab */}
        {activePropertiesTab === 'cursor' && <CursorPanel />}

        {/* Pattern Tab */}
        {activePropertiesTab === 'pattern' && <PatternImportPanel />}

        {/* Zoom Tab */}
        {activePropertiesTab === 'zoom' && <ZoomPanel />}
      </div>

      {/* Export buttons - always at bottom */}
      <div className="pt-4 border-t border-border space-y-3 gap-2 flex justify-between w-full">
        <Button onClick={() => setModalOpen(true)} className="w-5/6">
          <Download className="size-4" />
          Export
        </Button>

        <Button variant="outline" onClick={handleOpenExportsFolder} className="w-1/6">
          <FolderOpen className="size-4" />
        </Button>
      </div>

      {/* Export Modal */}
      <ExportModal open={isModalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}
