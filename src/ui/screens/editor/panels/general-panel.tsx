import { ImagePlus, RefreshCcw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

import { PaginatedGrid } from '@/components/paginated-grid';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/store/project-store';
import type { BackgroundMode } from '@/types';

import {
  type BackgroundPatternConfig,
  patternPresets as patterns,
} from '../../../../shared/patterns';
import {
  CANVAS_PADDING_STEP,
  MAX_CANVAS_PADDING,
  MIN_CANVAS_PADDING,
  resolveCanvasPadding,
} from '../engine/canvas-layout';
import {
  PANEL_LABEL,
  PanelNote,
  PanelRow,
  PanelSection,
  PanelSlider,
  Segmented,
} from './panel-kit';
import { PatternImportPanel } from './pattern-import-panel';

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

const BACKGROUND_MODE_OPTIONS: { value: BackgroundMode; label: string }[] = [
  { value: 'color', label: 'Colour' },
  { value: 'pattern', label: 'Pattern' },
  { value: 'image', label: 'Image' },
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

function resolveBackgroundMode(
  backgroundMode: BackgroundMode | undefined,
  backgroundPath: string | undefined,
  backgroundPattern: BackgroundPatternConfig | null | undefined,
): BackgroundMode {
  if (backgroundMode === 'color' || backgroundMode === 'pattern' || backgroundMode === 'image') {
    return backgroundMode;
  }

  if (backgroundPath) {
    return 'image';
  }

  const hasPattern = Boolean(backgroundPattern && backgroundPattern.id !== 'none');
  if (hasPattern) {
    return 'pattern';
  }

  return 'color';
}

export function GeneralPanel() {
  const {
    project,
    updateBackgroundColor,
    updateBackgroundPattern,
    updateBackgroundPath,
    updateBackgroundMode,
    updateCanvasBackgroundEnabled,
    updateCanvasPadding,
  } = useProjectStore();
  const [presetColors, setPresetColors] = useState<string[]>(PASTEL_COLORS);
  const hasCrop = useProjectStore((state) => {
    const c = state.project?.cropConfig;
    if (!c) return false;
    return c.top > 0 || c.left > 0 || c.bottom > 0 || c.right > 0;
  });
  if (!project) return null;

  const isBackgroundEnabled = project.canvasBackgroundEnabled !== false;
  const canvasPadding = resolveCanvasPadding(project);
  const backgroundMode = resolveBackgroundMode(
    project.backgroundMode,
    project.backgroundPath,
    project.backgroundPattern,
  );

  const handleRefreshColors = () => {
    const isHueMode = Math.random() > 0.5;
    const newColors: string[] = [];

    if (isHueMode) {
      // Random hues with fixed saturation and lightness.
      const s = Math.floor(Math.random() * 41) + 50; // 50-90%
      const l = Math.floor(Math.random() * 21) + 70; // 70-90%
      const baseHue = Math.floor(Math.random() * 360);

      for (let i = 0; i < 8; i++) {
        newColors.push(hslToHex((baseHue + i * 45) % 360, s, l));
      }
    } else {
      // Random saturation with fixed hue and lightness.
      const h = Math.floor(Math.random() * 360);
      const l = Math.floor(Math.random() * 21) + 70; // 70-90%

      for (let i = 0; i < 8; i++) {
        newColors.push(hslToHex(h, 20 + i * 10, l));
      }
    }

    setPresetColors(newColors);
  };

  const pickBackgroundImage = async () => {
    const path = await window.electron.compositor.showBackgroundPicker();
    if (path) {
      updateBackgroundPath(path);
      updateBackgroundMode('image');
    }
  };

  const patternItems = Object.entries(patterns).map(([, config]) => ({ ...config }));

  return (
    <>
      <PanelRow
        label="Canvas background"
        hint={
          hasCrop
            ? 'Unavailable while the recording is cropped'
            : isBackgroundEnabled
              ? 'Padded canvas behind the recording'
              : 'Recording fills the frame'
        }
        control={
          <Switch
            checked={isBackgroundEnabled}
            onCheckedChange={updateCanvasBackgroundEnabled}
            disabled={!!hasCrop}
          />
        }
      />

      <AnimatePresence initial={false}>
        {isBackgroundEnabled && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-5">
              <PanelSlider
                label="Padding"
                value={canvasPadding}
                min={MIN_CANVAS_PADDING}
                max={MAX_CANVAS_PADDING}
                step={CANVAS_PADDING_STEP}
                onChange={updateCanvasPadding}
                format={(value) => `${(value * 100).toFixed(1)}%`}
                hint="Space between the recording and the canvas edge."
              />

              <Segmented
                options={BACKGROUND_MODE_OPTIONS}
                value={backgroundMode}
                onChange={updateBackgroundMode}
              />

              {backgroundMode === 'color' && (
                <PanelSection
                  title="Colour"
                  action={
                    <button
                      type="button"
                      onClick={handleRefreshColors}
                      title="Shuffle presets"
                      aria-label="Shuffle colour presets"
                      className="grid size-6 cursor-pointer place-items-center rounded-[8px] text-white/40 transition hover:bg-white/10 hover:text-white"
                    >
                      <RefreshCcw className="size-3" />
                    </button>
                  }
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={project.backgroundColor || '#000000'}
                      onChange={(e) => updateBackgroundColor(e.target.value)}
                      className="h-8 flex-1 font-mono text-xs"
                      placeholder="#000000"
                      aria-label="Background colour hex"
                    />
                    <Input
                      type="color"
                      value={project.backgroundColor || '#000000'}
                      onChange={(e) => updateBackgroundColor(e.target.value)}
                      className="h-8 w-10 border-0 p-0"
                      aria-label="Background colour picker"
                    />
                  </div>

                  <motion.div layout className="grid grid-cols-8 gap-1.5">
                    {presetColors.map((color) => (
                      <motion.button
                        type="button"
                        key={color}
                        whileHover={{ scale: 1.12 }}
                        whileTap={{ scale: 0.92 }}
                        title={color}
                        aria-label={`Use ${color}`}
                        className={cn(
                          'aspect-square cursor-pointer rounded-[7px] border transition-colors',
                          project.backgroundColor?.toLowerCase() === color.toLowerCase()
                            ? 'border-[#5eead4] shadow-[0_0_0_2px_rgba(94,234,212,0.25)]'
                            : 'border-white/15 hover:border-white/40',
                        )}
                        style={{ backgroundColor: color }}
                        onClick={() => updateBackgroundColor(color)}
                      />
                    ))}
                  </motion.div>
                </PanelSection>
              )}

              {backgroundMode === 'pattern' && (
                <PanelSection title="Pattern">
                  <PaginatedGrid<BackgroundPatternConfig>
                    items={patternItems}
                    itemsPerPage={8}
                    gridClassName="grid-cols-4 gap-2"
                    className="w-full"
                    disableAnimation
                    renderItem={(pattern) => (
                      <button
                        type="button"
                        className={cn(
                          'relative aspect-square w-full cursor-pointer overflow-hidden rounded-[10px] border transition-colors',
                          project.backgroundPattern?.id === pattern.id
                            ? 'border-[#5eead4]/60 shadow-[0_0_0_2px_rgba(94,234,212,0.2)]'
                            : 'border-white/10 hover:border-white/35',
                        )}
                        onClick={() => {
                          updateBackgroundPattern(pattern);
                          updateBackgroundMode('pattern');
                        }}
                        title={pattern.label}
                        aria-label={pattern.label}
                      >
                        <span
                          className="absolute inset-0"
                          style={{
                            backgroundColor: project.backgroundColor || '#ffffff',
                            ...pattern.containerStyle,
                          }}
                        >
                          {pattern.id !== 'none' && (
                            <span className="absolute inset-0" style={pattern.style} />
                          )}
                          {pattern.id === 'none' && (
                            <span className="absolute inset-0 grid place-items-center">
                              <span className="absolute h-px w-full rotate-45 bg-red-500/70" />
                            </span>
                          )}
                        </span>
                      </button>
                    )}
                  />
                  <PatternImportPanel />
                </PanelSection>
              )}

              {backgroundMode === 'image' && (
                <PanelSection
                  title="Image"
                  action={
                    project.backgroundPath ? (
                      <button
                        type="button"
                        onClick={() => updateBackgroundPath(null)}
                        className="cursor-pointer text-[10px] font-[750] uppercase tracking-[0.1em] text-red-300/80 transition hover:text-red-300"
                      >
                        Remove
                      </button>
                    ) : undefined
                  }
                >
                  {project.backgroundPath ? (
                    <button
                      type="button"
                      className="group relative aspect-video w-full cursor-pointer overflow-hidden rounded-[12px] border border-white/10 transition-colors hover:border-[#5eead4]/50"
                      onClick={() => void pickBackgroundImage()}
                    >
                      <img
                        src={`file://${project.backgroundPath}`}
                        alt="Custom background"
                        className="size-full object-cover"
                      />
                      <span className="absolute inset-0 grid place-items-center bg-black/55 text-[12px] font-[650] text-white opacity-0 transition-opacity group-hover:opacity-100">
                        Change image
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="grid h-24 w-full cursor-pointer place-items-center content-center gap-2 rounded-[12px] border border-dashed border-white/15 text-white/45 transition-colors hover:border-[#5eead4]/40 hover:text-white/70"
                      onClick={() => void pickBackgroundImage()}
                    >
                      <ImagePlus className="size-5" />
                      <span className={PANEL_LABEL}>Choose an image</span>
                    </button>
                  )}

                  <PanelNote>The image is scaled to cover the canvas.</PanelNote>
                </PanelSection>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
