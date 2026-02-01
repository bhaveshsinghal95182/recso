/**
 * CursorSettings — Controls for cursor/click appearance and behavior.
 * Simplified version: removed smoothing options (velocity removed).
 */

import { useEditor } from '../../../../context/editor-context';

export function CursorSettings() {
  const { project, updateCursorConfig } = useEditor();

  if (!project) return null;

  const { cursorConfig } = project;

  return (
    <div className="mb-6">
      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">
        Click Indicator
      </h3>

      {/* Size slider */}
      <div className="flex justify-between items-center mb-3">
        <span className="text-[13px] text-muted-foreground">Size</span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.1}
            value={cursorConfig.size}
            onChange={(e) => updateCursorConfig({ size: Number(e.target.value) })}
            className="w-[100px] accent-primary h-1 bg-white/10 rounded-lg appearance-none cursor-pointer"
          />
          <span style={{ fontSize: 12, minWidth: 30 }}>{cursorConfig.size.toFixed(1)}x</span>
        </div>
      </div>

      {/* Click animations toggle */}
      <div className="flex justify-between items-center mb-3">
        <span className="text-[13px] text-muted-foreground">Show Click Animations</span>
        <div
          className={`w-10 h-[22px] rounded-full relative cursor-pointer transition-colors ${
            cursorConfig.showClickAnimations ? 'bg-primary' : 'bg-input'
          }`}
          onClick={() =>
            updateCursorConfig({ showClickAnimations: !cursorConfig.showClickAnimations })
          }
        >
          <div
            className={`absolute w-[18px] h-[18px] bg-white rounded-full top-[2px] left-[2px] transition-transform ${
              cursorConfig.showClickAnimations ? 'translate-x-[18px]' : ''
            }`}
          />
        </div>
      </div>

      {/* Click animation scale */}
      {cursorConfig.showClickAnimations && (
        <div className="flex justify-between items-center mb-3">
          <span className="text-[13px] text-muted-foreground">Click Scale</span>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={cursorConfig.clickAnimationScale}
              onChange={(e) => updateCursorConfig({ clickAnimationScale: Number(e.target.value) })}
              className="w-[100px] accent-primary h-1 bg-white/10 rounded-lg appearance-none cursor-pointer"
            />
            <span style={{ fontSize: 12, minWidth: 30 }}>
              {cursorConfig.clickAnimationScale.toFixed(1)}x
            </span>
          </div>
        </div>
      )}

      {/* Click display duration */}
      <div className="flex justify-between items-center mb-3">
        <span className="text-[13px] text-muted-foreground">Click Duration</span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={100}
            max={1000}
            step={50}
            value={cursorConfig.clickDisplayDuration}
            onChange={(e) => updateCursorConfig({ clickDisplayDuration: Number(e.target.value) })}
            className="w-[100px] accent-primary h-1 bg-white/10 rounded-lg appearance-none cursor-pointer"
          />
          <span style={{ fontSize: 12, minWidth: 40 }}>{cursorConfig.clickDisplayDuration}ms</span>
        </div>
      </div>
    </div>
  );
}
