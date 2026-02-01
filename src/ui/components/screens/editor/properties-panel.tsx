import { useEditor } from '../../../context/editor-context';

export function PropertiesPanel() {
  const { project, updateBackgroundColor } = useEditor();

  if (!project) return null;

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
    </div>
  );
}
