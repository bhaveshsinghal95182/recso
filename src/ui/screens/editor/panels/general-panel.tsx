import { ImagePlus, RefreshCcw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

import { PaginatedGrid } from '@/components/paginated-grid';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useProjectStore } from '@/store/project-store';
import type { WebcamOverlayShape, WebcamOverlaySize } from '@/types';

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

const DEFAULT_WEBCAM_SHAPE: WebcamOverlayShape = 'rectangle-portrait';
const DEFAULT_WEBCAM_SIZE: WebcamOverlaySize = 'medium';
const DEFAULT_WEBCAM_BORDER_RADIUS_PX = 24;

const WEBCAM_SHAPE_ASPECT_RATIO: Record<WebcamOverlayShape, number> = {
  circle: 1,
  square: 1,
  'rectangle-landscape': 16 / 9,
  'rectangle-portrait': 3 / 4,
};

const WEBCAM_SIZE_HEIGHT_RATIO: Record<WebcamOverlaySize, number> = {
  small: 0.26,
  medium: 0.34,
  large: 0.42,
};

const WEBCAM_SHAPE_OPTIONS: Array<{ value: WebcamOverlayShape; label: string }> = [
  { value: 'circle', label: 'Circle' },
  { value: 'rectangle-landscape', label: 'Rectangle (Landscape)' },
  { value: 'rectangle-portrait', label: 'Rectangle (Portrait)' },
  { value: 'square', label: 'Square' },
];

const WEBCAM_SIZE_OPTIONS: Array<{ value: WebcamOverlaySize; label: string }> = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

function isWebcamOverlayShape(value: unknown): value is WebcamOverlayShape {
  return (
    value === 'circle' ||
    value === 'rectangle-landscape' ||
    value === 'rectangle-portrait' ||
    value === 'square'
  );
}

function isWebcamOverlaySize(value: unknown): value is WebcamOverlaySize {
  return value === 'small' || value === 'medium' || value === 'large';
}

function inferWebcamShape(
  shape: WebcamOverlayShape | undefined,
  aspectRatio: number | undefined,
  borderRadiusPx: number | undefined,
): WebcamOverlayShape {
  if (isWebcamOverlayShape(shape)) {
    return shape;
  }

  if (!Number.isFinite(aspectRatio)) {
    return DEFAULT_WEBCAM_SHAPE;
  }

  const ratio = aspectRatio as number;
  if (Math.abs(ratio - 1) <= 0.05) {
    if (Number.isFinite(borderRadiusPx) && (borderRadiusPx as number) >= 999) {
      return 'circle';
    }
    return 'square';
  }

  if (ratio > 1.05) {
    return 'rectangle-landscape';
  }

  return DEFAULT_WEBCAM_SHAPE;
}

function inferWebcamSize(
  size: WebcamOverlaySize | undefined,
  heightRatio: number | undefined,
): WebcamOverlaySize {
  if (isWebcamOverlaySize(size)) {
    return size;
  }

  if (!Number.isFinite(heightRatio)) {
    return DEFAULT_WEBCAM_SIZE;
  }

  const ratio = heightRatio as number;
  const entries = Object.entries(WEBCAM_SIZE_HEIGHT_RATIO) as Array<[WebcamOverlaySize, number]>;

  let closestSize = DEFAULT_WEBCAM_SIZE;
  let closestDiff = Number.POSITIVE_INFINITY;

  for (const [candidateSize, candidateHeightRatio] of entries) {
    const diff = Math.abs(ratio - candidateHeightRatio);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestSize = candidateSize;
    }
  }

  return closestSize;
}

function buildWebcamPreset(shape: WebcamOverlayShape, size: WebcamOverlaySize) {
  return {
    shape,
    size,
    aspectRatio: WEBCAM_SHAPE_ASPECT_RATIO[shape],
    heightRatio: WEBCAM_SIZE_HEIGHT_RATIO[size],
    borderRadiusPx: DEFAULT_WEBCAM_BORDER_RADIUS_PX,
  };
}

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
    updateWebcamOverlay,
  } = useProjectStore();
  const [presetColors, setPresetColors] = useState<string[]>(PASTEL_COLORS);

  if (!project) return null;

  const isBackgroundEnabled = project.backgroundColor !== 'transparent';
  const webcamSourcePath = project.webcamOverlay?.sourcePath;
  const canToggleWebcam = Boolean(webcamSourcePath);
  const isWebcamEnabled = Boolean(project.webcamOverlay?.enabled && canToggleWebcam);
  const webcamShape = inferWebcamShape(
    project.webcamOverlay?.shape,
    Number.isFinite(project.webcamOverlay?.aspectRatio)
      ? (project.webcamOverlay?.aspectRatio as number)
      : undefined,
    Number.isFinite(project.webcamOverlay?.borderRadiusPx)
      ? (project.webcamOverlay?.borderRadiusPx as number)
      : undefined,
  );
  const webcamSize = inferWebcamSize(
    project.webcamOverlay?.size,
    Number.isFinite(project.webcamOverlay?.heightRatio)
      ? (project.webcamOverlay?.heightRatio as number)
      : undefined,
  );

  const handleBackgroundToggle = (checked: boolean) => {
    if (checked) {
      updateBackgroundColor('#000000');
    } else {
      updateBackgroundColor('transparent');
      updateBackgroundPattern(null); // Clear the pattern when background is disabled
    }
  };

  const handleWebcamToggle = (checked: boolean) => {
    if (!canToggleWebcam) {
      return;
    }

    void updateWebcamOverlay({ enabled: checked });
  };

  const applyWebcamPreset = (shape: WebcamOverlayShape, size: WebcamOverlaySize) => {
    if (!canToggleWebcam) {
      return;
    }

    void updateWebcamOverlay(buildWebcamPreset(shape, size));
  };

  const handleWebcamShapeChange = (value: string) => {
    if (!isWebcamOverlayShape(value)) {
      return;
    }

    applyWebcamPreset(value, webcamSize);
  };

  const handleWebcamSizeChange = (value: string) => {
    if (!isWebcamOverlaySize(value)) {
      return;
    }

    applyWebcamPreset(webcamShape, value);
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

        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <label className="text-sm font-medium">Webcam Overlay</label>
            <p className="text-[11px] text-muted-foreground">
              {canToggleWebcam
                ? 'Show recorded webcam overlay in preview/export'
                : 'No webcam recording found for this project'}
            </p>
          </div>
          <Switch
            checked={isWebcamEnabled}
            onCheckedChange={handleWebcamToggle}
            disabled={!canToggleWebcam}
          />
        </div>

        {canToggleWebcam && (
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Shape</Label>
              <Select value={webcamShape} onValueChange={handleWebcamShapeChange}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select shape" />
                </SelectTrigger>
                <SelectContent>
                  {WEBCAM_SHAPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Size</Label>
              <Select value={webcamSize} onValueChange={handleWebcamSizeChange}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select size" />
                </SelectTrigger>
                <SelectContent>
                  {WEBCAM_SIZE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

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
