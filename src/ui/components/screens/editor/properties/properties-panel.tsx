import { CursorSettings } from '@/components/screens/editor/properties/cursor-settings';
import { useEditor } from '@/context/editor-context';

export function PropertiesPanel() {
  const { project, saveProject } = useEditor();

  if (!project) return null;

  return (
    <div className="p-4">
      <div className="mb-6">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">Project</h3>
        <div className="flex justify-between items-center mb-3">
          <span className="text-[13px] text-muted-foreground">Name</span>
          <span className="flex items-center gap-2 text-foreground">{project.name}</span>
        </div>
        <button
          onClick={saveProject}
          className="w-full py-2 px-3 bg-primary border-0 rounded-md text-primary-foreground cursor-pointer text-[13px] mt-2 hover:bg-primary/90 transition-colors"
        >
          Save Project
        </button>
      </div>

      <CursorSettings />

      <div className="mb-6">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">
          Background
        </h3>
        <div className="flex justify-between items-center mb-3">
          <span className="text-[13px] text-muted-foreground">Color</span>
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: 4,
              background: project.backgroundColor,
              border: '1px solid rgba(255,255,255,0.2)',
            }}
          />
        </div>
      </div>
    </div>
  );
}
