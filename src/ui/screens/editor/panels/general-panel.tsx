import { ImagePlus, RefreshCcw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

import { PaginatedGrid } from '@/components/paginated-grid';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useProjectStore } from '@/store/project-store';

import {
  type BackgroundPatternConfig,
  patternPresets as patterns,
} from '../../../../shared/patterns';

const PASTEL_COLORS = [
  '#FFADAD',
  '#FFD6A5',
  '#FDFFB6',
  '#CAFFBF',
  '#9BF6FF',
  '#A0C4FF',
  '#BDB2FF',
  '#FFC6FF',
];

function hslToHex(h: number, s: number, l: number) {
  l /= 100;
  const a = (s * Math.min(l, 1 - l)) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function GeneralPanel() {
  const {
    project,
    updateBackgroundColor,
    updateBackgroundPattern,
    updateBackgroundPath,
    updateCanvasBackgroundEnabled,
  } = useProjectStore();
  const [presetColors, setPresetColors] = useState<string[]>(PASTEL_COLORS);

  if (!project) return null;

  const isBackgroundEnabled = project.canvasBackgroundEnabled !== false;

  const handleBackgroundToggle = (checked: boolean) => {
    updateCanvasBackgroundEnabled(checked);
  };

  const handleRefreshColors = () => {
    const isHueMode = Math.random() > 0.5;
    const newColors: string[] = [];

    if (isHueMode) {
      // Random Hues with fixed Saturation and Lightness
      const s = Math.floor(Math.random() * 41) + 50; // 50-90%
      const l = Math.floor(Math.random() * 21) + 70; // 70-90%
      const baseHue = Math.floor(Math.random() * 360);

      for (let i = 0; i < 8; i++) {
        const h = (baseHue + i * 45) % 360;
        newColors.push(hslToHex(h, s, l));
      }
    } else {
      // Random Saturation with fixed Hue and Lightness
      const h = Math.floor(Math.random() * 360);
      const l = Math.floor(Math.random() * 21) + 70; // 70-90%

      for (let i = 0; i < 8; i++) {
        const s = 20 + i * 10; // 20% to 90%
        newColors.push(hslToHex(h, s, l));
      }
    }
    setPresetColors(newColors);
  };

  const patternItems = Object.entries(patterns).map(([, config]) => ({
    ...config,
  }));

  return (
    <motion.div className="space-y-4 overflow-hidden overflow-y-hidden">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <label htmlFor="bg-color" className="text-sm font-medium">
            Canvas Background
          </label>
          <Switch checked={isBackgroundEnabled} onCheckedChange={handleBackgroundToggle} />
        </div>

        <AnimatePresence initial={false}>
          {isBackgroundEnabled && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="space-y-6 pt-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Base Color</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        value={project.backgroundColor || '#000000'}
                        onChange={(e) => updateBackgroundColor(e.target.value)}
                        className="font-mono text-xs h-6 w-20"
                        placeholder="#000000"
                      />
                      <Input
                        type="color"
                        value={project.backgroundColor || '#000000'}
                        onChange={(e) => updateBackgroundColor(e.target.value)}
                        className="h-6 w-8 p-0 border-0"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-2">
                    <Label className="text-xs text-muted-foreground">Presets</Label>
                    <Button
                      size="icon"
                      variant={'ghost'}
                      className="h-6 w-6"
                      onClick={handleRefreshColors}
                    >
                      <RefreshCcw className="size-3" />
                    </Button>
                  </div>

                  <motion.div layout className="grid grid-cols-4 gap-2 w-fit mx-auto">
                    {presetColors.map((color) => (
                      <motion.div
                        key={color}
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        className="h-8 w-8 rounded-sm border border-black/20 cursor-pointer shadow-sm"
                        style={{ backgroundColor: color }}
                        onClick={() => updateBackgroundColor(color)}
                      />
                    ))}
                  </motion.div>
                </div>

                {/* 2.5. Custom Image */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Custom Image</Label>
                    {project.backgroundPath && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[10px] text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => updateBackgroundPath(null)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>

                  {project.backgroundPath ? (
                    <div
                      className="relative w-full aspect-video rounded-md border border-border/50 overflow-hidden group cursor-pointer transition-all hover:border-primary/50"
                      onClick={async () => {
                        const path = await window.electron.compositor.showBackgroundPicker();
                        if (path) updateBackgroundPath(path);
                      }}
                    >
                      <img
                        src={`file://${project.backgroundPath}`}
                        alt="Custom background"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-all duration-200">
                        <span className="text-white text-xs font-medium">Change Image</span>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="w-full h-24 rounded-md border border-dashed border-border/60 hover:border-primary/50 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors bg-muted/10 hover:bg-muted/30"
                      onClick={async () => {
                        const path = await window.electron.compositor.showBackgroundPicker();
                        if (path) updateBackgroundPath(path);
                      }}
                    >
                      <ImagePlus className="w-5 h-5 text-muted-foreground/70" />
                      <span className="text-[11px] text-muted-foreground font-medium">
                        Click to upload image
                      </span>
                    </div>
                  )}
                </div>

                {/* 3. Paginated Background Patterns */}
                <div className="space-y-2">
                  <Label>Patterns</Label>
                  <PaginatedGrid<BackgroundPatternConfig>
                    items={patternItems}
                    itemsPerPage={8}
                    gridClassName="grid-cols-4"
                    className="w-full max-w-44 mx-auto"
                    disableAnimation
                    renderItem={(pattern) => (
                      <div
                        className={`
                          cursor-pointer rounded-md border-2 overflow-hidden relative aspect-square
                          ${project.backgroundPattern?.id === pattern.id ? 'border-primary' : 'border-border hover:border-primary/50'}
                        `}
                        onClick={() => updateBackgroundPattern(pattern)}
                        title={pattern.label}
                      >
                        <div
                          className="absolute inset-0"
                          style={{
                            backgroundColor: project.backgroundColor || '#ffffff',
                            ...pattern.containerStyle,
                          }}
                        >
                          {pattern.id !== 'none' && (
                            <div className="absolute inset-0" style={pattern.style} />
                          )}
                          {pattern.id === 'none' && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <div className="w-full h-px bg-red-500 rotate-45 transform absolute" />
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
