import { Download, FolderOpen } from 'lucide-react';

import { useExportStore } from '@/store/export-store';
import { useProjectStore } from '@/store/project-store';
import { useUIStore } from '@/store/ui-store';

import { CursorPanel } from './panels/cursor-panel';
import { GeneralPanel } from './panels/general-panel';
import { WebcamPanel } from './panels/webcam-panel';
import { ZoomPanel } from './panels/zoom-panel';
import { ExportModal } from './export-modal';

const TAB_TITLES: Record<string, { title: string; hint: string }> = {
  general: { title: 'General', hint: 'Canvas and background' },
  webcam: { title: 'Webcam', hint: 'Overlay and webcam regions' },
  cursor: { title: 'Cursor', hint: 'Pointer size and style' },
  zoom: { title: 'Zoom', hint: 'Screen zoom regions' },
  export: { title: 'Export', hint: 'Render the final video' },
};

export function PropertiesPanel() {
  const { project } = useProjectStore();
  const { activePropertiesTab } = useUIStore();
  const { isModalOpen, setModalOpen } = useExportStore();

  if (!project) return null;

  const handleOpenExportsFolder = async () => {
    await window.electron.exporter.openExportsFolder();
  };

  const tab = TAB_TITLES[activePropertiesTab] ?? TAB_TITLES.general;

  return (
    <div className="flex h-full flex-col bg-[linear-gradient(180deg,rgba(255,255,255,0.04),transparent_38%),rgba(12,14,14,0.94)]">
      <header className="flex-none border-b border-white/[0.07] px-4 py-3">
        <h3 className="text-[15px] font-[700] text-white/90">{tab.title}</h3>
        <p className="mt-0.5 text-[11px] text-white/35">{tab.hint}</p>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {activePropertiesTab === 'general' && <GeneralPanel />}
        {activePropertiesTab === 'webcam' && <WebcamPanel />}
        {activePropertiesTab === 'cursor' && <CursorPanel />}
        {activePropertiesTab === 'zoom' && <ZoomPanel />}
      </div>

      <div className="flex flex-none gap-2 border-t border-white/[0.07] px-4 py-3">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-[14px] bg-[linear-gradient(180deg,#34d399,#10b981)] px-3 py-2.5 text-[13px] font-[700] text-[#04231a] shadow-[inset_0_1px_0_rgba(255,255,255,0.32),0_8px_20px_rgba(16,185,129,0.28)] transition duration-150 hover:-translate-y-px hover:brightness-110"
        >
          <Download className="size-4" />
          Export
        </button>

        <button
          type="button"
          onClick={handleOpenExportsFolder}
          title="Open exports folder"
          aria-label="Open exports folder"
          className="grid size-[42px] flex-none cursor-pointer place-items-center rounded-[14px] border border-white/10 bg-white/[0.055] text-white/70 transition duration-150 hover:border-white/20 hover:bg-white/10 hover:text-white"
        >
          <FolderOpen className="size-4" />
        </button>
      </div>

      <ExportModal open={isModalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}
