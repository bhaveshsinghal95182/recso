import { RefreshCcw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useProjectStore } from '@/store/project-store';

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
  const { project, updateBackgroundColor } = useProjectStore();
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
              <div className="space-y-2 pt-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-12">Hex</span>
                  <Input
                    value={project.backgroundColor || '#000000'}
                    onChange={(e) => updateBackgroundColor(e.target.value)}
                    className="font-mono text-xs h-8"
                    placeholder="#000000"
                  />
                  <Input
                    type="color"
                    value={project.backgroundColor || '#000000'}
                    onChange={(e) => updateBackgroundColor(e.target.value)}
                    className="h-8 w-14"
                  />
                </div>
                <div className="space-y-2 mt-4">
                  <div className="flex items-center justify-between">
                    <Label>Preset Colors</Label>
                    <Button size="sm" variant={'outline'} onClick={handleRefreshColors}>
                      <RefreshCcw className="size-4" />
                    </Button>
                  </div>
                  <motion.div layout className="grid grid-cols-4 gap-2 w-fit mx-auto">
                    {presetColors.map((color) => (
                      <motion.div
                        key={color}
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        className="h-8 w-8 rounded-sm border border-black/20 cursor-pointer"
                        style={{ backgroundColor: color }}
                        onClick={() => updateBackgroundColor(color)}
                      />
                    ))}
                  </motion.div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
