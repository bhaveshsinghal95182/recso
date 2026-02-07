import { useEditor } from '../../../../context/editor-context';

export function CursorPanel() {
  const { project, updateCursorConfig } = useEditor();

  if (!project) return null;

  const cursor = project.cursorConfig;
  const onCursorChange = (patch: Partial<typeof cursor>) => {
    updateCursorConfig(patch);
  };

  return (
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
        <div className="text-xs text-muted-foreground font-mono">{cursor.size.toFixed(1)}×</div>
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
          onChange={(e) => onCursorChange({ clickAnimationScale: parseFloat(e.target.value) })}
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
          onChange={(e) => onCursorChange({ clickDisplayDuration: parseInt(e.target.value, 10) })}
          className="w-full p-2 rounded border border-border bg-card text-sm"
        />
      </div>
    </div>
  );
}
