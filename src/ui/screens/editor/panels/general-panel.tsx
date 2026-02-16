import { RefreshCcw } from 'lucide-react';
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
} from '../../../../remotion/patterns';

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
  const { project, updateBackgroundColor, updateBackgroundPattern } = useProjectStore();
  const [presetColors, setPresetColors] = useState<string[]>(PASTEL_COLORS);

  if (!project) return null;

  const isBackgroundEnabled = project.backgroundColor !== 'transparent';

  const handleBackgroundToggle = (checked: boolean) => {
    if (checked) {
      updateBackgroundColor('#000000');
    } else {
      updateBackgroundColor('transparent');
    }
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
                {/* 1. Reusable Filters Section */}
                <div className="space-y-2">
                  <Label>Filters</Label>
                  {/* Placeholder for future filters */}
                  <div className="text-xs text-muted-foreground italic">
                    No filters available yet.
                  </div>
                </div>

                {/* 2. Preset Colors Section */}
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

                {/* 3. Paginated Background Patterns */}
                <div className="space-y-2">
                  <Label>Patterns</Label>
                  <PaginatedGrid<BackgroundPatternConfig>
                    items={patternItems}
                    itemsPerPage={8}
                    gridClassName="grid-cols-2"
                    className="w-full"
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
                              <div className="w-full h-[1px] bg-red-500 rotate-45 transform absolute" />
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
