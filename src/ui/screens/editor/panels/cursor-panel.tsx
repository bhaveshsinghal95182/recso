import { ImagePlus } from 'lucide-react';
import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useProjectStore } from '@/store/project-store';

type SvgNode = [tag: string, attrs: Record<string, string>];

type CursorIconPreset = {
  id: string;
  label: string;
  dataUrl: string;
};

const LUCIDE_MOUSE_POINTER_2_NODE: SvgNode[] = [
  [
    'path',
    {
      d: 'M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z',
    },
  ],
];

const LUCIDE_MOUSE_POINTER_CLICK_NODE: SvgNode[] = [
  ['path', { d: 'M14 4.1 12 6' }],
  ['path', { d: 'm5.1 8-2.9-.8' }],
  ['path', { d: 'm6 12-1.9 2' }],
  ['path', { d: 'M7.2 2.2 8 5.1' }],
  [
    'path',
    {
      d: 'M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z',
    },
  ],
];

const LUCIDE_HAND_NODE: SvgNode[] = [
  ['path', { d: 'M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2' }],
  ['path', { d: 'M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2' }],
  ['path', { d: 'M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8' }],
  [
    'path',
    {
      d: 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
    },
  ],
];

const LUCIDE_CROSSHAIR_NODE: SvgNode[] = [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['line', { x1: '22', x2: '18', y1: '12', y2: '12' }],
  ['line', { x1: '6', x2: '2', y1: '12', y2: '12' }],
  ['line', { x1: '12', x2: '12', y1: '6', y2: '2' }],
  ['line', { x1: '12', x2: '12', y1: '22', y2: '18' }],
];

const LUCIDE_CURSOR_STROKE = '#ffffff';

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function createLucideIconDataUrl(iconNode: SvgNode[], strokeWidth = 2): string {
  const body = iconNode
    .map(([tag, attrs]) => {
      const serializedAttrs = Object.entries(attrs)
        .map(([key, value]) => `${key}="${escapeXmlAttribute(value)}"`)
        .join(' ');
      return `<${tag} ${serializedAttrs}></${tag}>`;
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="${LUCIDE_CURSOR_STROKE}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function buildLucideCursorPresets(): CursorIconPreset[] {
  return [
    {
      id: 'lucide-pointer-light',
      label: 'Lucide Pointer',
      dataUrl: createLucideIconDataUrl(LUCIDE_MOUSE_POINTER_2_NODE),
    },
    {
      id: 'lucide-pointer-click',
      label: 'Lucide Click',
      dataUrl: createLucideIconDataUrl(LUCIDE_MOUSE_POINTER_CLICK_NODE),
    },
    {
      id: 'lucide-hand',
      label: 'Lucide Hand',
      dataUrl: createLucideIconDataUrl(LUCIDE_HAND_NODE),
    },
    {
      id: 'lucide-crosshair',
      label: 'Lucide Crosshair',
      dataUrl: createLucideIconDataUrl(LUCIDE_CROSSHAIR_NODE),
    },
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toImageSrc(path: string | undefined): string | null {
  if (!path) {
    return null;
  }

  if (path.startsWith('data:') || path.startsWith('file:') || path.startsWith('http')) {
    return path;
  }

  const normalized = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }

  if (normalized.startsWith('/')) {
    return `file://${encodeURI(normalized)}`;
  }

  return normalized;
}

export function CursorPanel() {
  const { project, updateCursorConfig } = useProjectStore();

  const lucidePresets = useMemo(buildLucideCursorPresets, []);

  if (!project) {
    return null;
  }

  const cursor = project.cursorConfig;
  const activeImage = toImageSrc(cursor.customImagePath);
  const showMotionBlur = cursor.showMotionBlur ?? true;
  const motionBlurStrength = Number.isFinite(cursor.motionBlurStrength)
    ? clamp(cursor.motionBlurStrength, 0, 2.5)
    : 0.7;

  const handleSizeInput = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) {
      return;
    }

    void updateCursorConfig({ size: clamp(nextValue, 0.2, 3) });
  };

  const handleClickScaleInput = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) {
      return;
    }

    void updateCursorConfig({ clickAnimationScale: clamp(nextValue, 0.5, 3) });
  };

  const handleClickDurationInput = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) {
      return;
    }

    void updateCursorConfig({ clickDisplayDuration: clamp(nextValue, 80, 3000) });
  };

  const handleMotionBlurStrengthInput = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) {
      return;
    }

    void updateCursorConfig({ motionBlurStrength: clamp(nextValue, 0, 2.5) });
  };

  const openCursorPicker = async () => {
    const selectedPath = await window.electron.editor.showCursorPicker();
    if (!selectedPath) {
      return;
    }

    await updateCursorConfig({ style: 'custom', customImagePath: selectedPath });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label>Lucide Icon Presets</Label>
        <div className="grid grid-cols-2 gap-2">
          {lucidePresets.map((preset) => {
            const isActive = cursor.style === 'custom' && cursor.customImagePath === preset.dataUrl;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() =>
                  void updateCursorConfig({ style: 'custom', customImagePath: preset.dataUrl })
                }
                className={`rounded-md border p-2 transition-colors ${
                  isActive
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-card hover:border-primary/50 hover:bg-muted/40'
                }`}
                title={preset.label}
              >
                <div className="h-10 rounded-sm bg-muted/40 flex items-center justify-center">
                  <img src={preset.dataUrl} alt={preset.label} className="h-7 w-7 object-contain" />
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground truncate">
                  {preset.label}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Custom PNG/SVG</Label>
          {cursor.style === 'custom' && cursor.customImagePath && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() =>
                void updateCursorConfig({ style: 'default', customImagePath: undefined })
              }
            >
              Reset
            </Button>
          )}
        </div>

        {activeImage ? (
          <button
            type="button"
            onClick={() => {
              void openCursorPicker();
            }}
            className="w-full h-16 rounded-md border border-border/60 bg-muted/10 hover:bg-muted/30 hover:border-primary/50 transition-colors flex items-center justify-center"
          >
            <img src={activeImage} alt="Custom cursor" className="h-10 w-10 object-contain" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              void openCursorPicker();
            }}
            className="w-full h-16 rounded-md border border-dashed border-border/60 hover:border-primary/50 flex flex-col items-center justify-center gap-1 cursor-pointer transition-colors bg-muted/10 hover:bg-muted/30"
          >
            <ImagePlus className="w-4 h-4 text-muted-foreground/70" />
            <span className="text-[11px] text-muted-foreground font-medium">
              Choose PNG/SVG file
            </span>
          </button>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="cursor-size">Cursor Size</Label>
        <div className="flex items-center gap-2">
          <input
            id="cursor-size-slider"
            type="range"
            min="0.2"
            max="3"
            step="0.1"
            value={cursor.size}
            onChange={(e) => handleSizeInput(Number(e.target.value))}
            className="flex-1"
          />
          <Input
            id="cursor-size"
            type="number"
            min="0.2"
            max="3"
            step="0.1"
            value={cursor.size}
            onChange={(e) => handleSizeInput(Number(e.target.value))}
            className="w-20 font-mono text-xs h-8"
          />
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-border/60 p-3 bg-muted/10">
        <div className="flex items-center justify-between">
          <Label htmlFor="motion-blur-toggle">Motion Blur</Label>
          <Switch
            id="motion-blur-toggle"
            checked={showMotionBlur}
            onCheckedChange={(checked) => void updateCursorConfig({ showMotionBlur: checked })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="motion-blur-strength">Blur Strength</Label>
          <div className="flex items-center gap-2">
            <input
              id="motion-blur-strength-slider"
              type="range"
              min="0"
              max="2.5"
              step="0.05"
              value={motionBlurStrength}
              disabled={!showMotionBlur}
              onChange={(e) => handleMotionBlurStrengthInput(Number(e.target.value))}
              className="flex-1"
            />
            <Input
              id="motion-blur-strength"
              type="number"
              min="0"
              max="2.5"
              step="0.05"
              value={motionBlurStrength}
              disabled={!showMotionBlur}
              onChange={(e) => handleMotionBlurStrengthInput(Number(e.target.value))}
              className="w-20 font-mono text-xs h-8"
            />
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-border/60 p-3 bg-muted/10">
        <div className="flex items-center justify-between">
          <Label htmlFor="click-animation-toggle">Click Animation</Label>
          <Switch
            id="click-animation-toggle"
            checked={cursor.showClickAnimations}
            onCheckedChange={(checked) => void updateCursorConfig({ showClickAnimations: checked })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="click-scale">Click Scale</Label>
          <div className="flex items-center gap-2">
            <input
              id="click-scale-slider"
              type="range"
              min="0.5"
              max="3"
              step="0.1"
              value={cursor.clickAnimationScale}
              disabled={!cursor.showClickAnimations}
              onChange={(e) => handleClickScaleInput(Number(e.target.value))}
              className="flex-1"
            />
            <Input
              id="click-scale"
              type="number"
              min="0.5"
              max="3"
              step="0.1"
              value={cursor.clickAnimationScale}
              disabled={!cursor.showClickAnimations}
              onChange={(e) => handleClickScaleInput(Number(e.target.value))}
              className="w-20 font-mono text-xs h-8"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="click-duration">Click Duration (ms)</Label>
          <Input
            id="click-duration"
            type="number"
            min="80"
            max="3000"
            step="10"
            value={cursor.clickDisplayDuration}
            disabled={!cursor.showClickAnimations}
            onChange={(e) => handleClickDurationInput(Number(e.target.value))}
            className="font-mono text-xs h-8"
          />
        </div>
      </div>
    </div>
  );
}
