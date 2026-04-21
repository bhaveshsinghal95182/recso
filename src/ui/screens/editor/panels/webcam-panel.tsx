import {
  Camera,
  Circle,
  Maximize2,
  Minimize2,
  RectangleHorizontal,
  RectangleVertical,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import { type ComponentType, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useProjectStore } from '@/store/project-store';
import type { WebcamOverlayShape, WebcamOverlaySize } from '@/types';

const DEFAULT_WEBCAM_SIZE: WebcamOverlaySize = 'medium';
const DEFAULT_WEBCAM_ASPECT_RATIO = 3 / 4;
const DEFAULT_WEBCAM_HEIGHT_RATIO = 0.34;
const DEFAULT_WEBCAM_BORDER_RADIUS_PX = 24;

const MIN_ASPECT_RATIO = 0.2;
const MAX_ASPECT_RATIO = 5;
const MIN_SIZE_PERCENT = 8;
const MAX_SIZE_PERCENT = 75;

type WebcamSizeOption = WebcamOverlaySize | 'custom';

interface IconOption<T extends string> {
  value: T;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  iconClassName?: string;
}

const SHAPE_OPTIONS: IconOption<WebcamOverlayShape>[] = [
  { value: 'circle', label: 'Circle', Icon: Circle },
  { value: 'rectangle-landscape', label: 'Landscape', Icon: RectangleHorizontal },
  { value: 'rectangle-portrait', label: 'Portrait', Icon: RectangleVertical },
  { value: 'square', label: 'Square', Icon: Square },
];

const SIZE_OPTIONS: IconOption<WebcamSizeOption>[] = [
  { value: 'small', label: 'Small', Icon: Minimize2 },
  { value: 'medium', label: 'Medium', Icon: Square, iconClassName: 'h-3.5 w-3.5' },
  { value: 'large', label: 'Large', Icon: Maximize2 },
  { value: 'custom', label: 'Custom', Icon: SlidersHorizontal },
];

const SHAPE_ASPECT_RATIO: Record<WebcamOverlayShape, number> = {
  circle: 1,
  square: 1,
  'rectangle-landscape': 16 / 9,
  'rectangle-portrait': 3 / 4,
};

const SIZE_HEIGHT_RATIO: Record<WebcamOverlaySize, number> = {
  small: 0.26,
  medium: 0.34,
  large: 0.42,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);

  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }

  return x || 1;
}

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

function resolveWebcamShape(
  shape: WebcamOverlayShape | undefined,
  aspectRatio: number,
): WebcamOverlayShape {
  if (isWebcamOverlayShape(shape)) {
    return shape;
  }

  if (Math.abs(aspectRatio - 1) <= 0.05) {
    return 'square';
  }

  return aspectRatio > 1.05 ? 'rectangle-landscape' : 'rectangle-portrait';
}

function resolveWebcamSizeOption(
  size: WebcamOverlaySize | undefined,
  heightRatio: number,
): WebcamSizeOption {
  if (isWebcamOverlaySize(size)) {
    return size;
  }

  const entries = Object.entries(SIZE_HEIGHT_RATIO) as Array<[WebcamOverlaySize, number]>;

  let closest: WebcamOverlaySize = DEFAULT_WEBCAM_SIZE;
  let closestDiff = Number.POSITIVE_INFINITY;

  for (const [candidate, candidateRatio] of entries) {
    const diff = Math.abs(heightRatio - candidateRatio);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = candidate;
    }
  }

  return closestDiff <= 0.015 ? closest : 'custom';
}

function ratioToParts(aspectRatio: number): { widthPart: string; heightPart: string } {
  const knownRatios = [
    { ratio: 1, widthPart: '1', heightPart: '1' },
    { ratio: 16 / 9, widthPart: '16', heightPart: '9' },
    { ratio: 4 / 3, widthPart: '4', heightPart: '3' },
    { ratio: 3 / 4, widthPart: '3', heightPart: '4' },
    { ratio: 9 / 16, widthPart: '9', heightPart: '16' },
  ];

  for (const known of knownRatios) {
    if (Math.abs(aspectRatio - known.ratio) <= 0.01) {
      return { widthPart: known.widthPart, heightPart: known.heightPart };
    }
  }

  const denominator = 100;
  const numerator = Math.max(1, Math.round(aspectRatio * denominator));
  const divisor = gcd(numerator, denominator);

  return {
    widthPart: String(Math.max(1, Math.round(numerator / divisor))),
    heightPart: String(Math.max(1, Math.round(denominator / divisor))),
  };
}

function shapeFromAspectRatio(aspectRatio: number): WebcamOverlayShape {
  if (Math.abs(aspectRatio - 1) <= 0.05) {
    return 'square';
  }

  return aspectRatio > 1.05 ? 'rectangle-landscape' : 'rectangle-portrait';
}

function IconPillOption({
  label,
  Icon,
  iconClassName,
  showLabel = true,
  active,
  disabled,
  onClick,
}: {
  label: string;
  Icon: ComponentType<{ className?: string }>;
  iconClassName?: string;
  showLabel?: boolean;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center rounded-full border py-1.5 text-xs transition-colors ${
        showLabel ? 'gap-2 px-3' : 'justify-center px-2.5'
      } ${
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'bg-background/90 text-foreground/65 hover:border-primary/65 hover:bg-primary/10'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
    >
      <Icon className={iconClassName ?? 'h-3.5 w-3.5'} />
      {showLabel && <span className="font-medium leading-none">{label}</span>}
    </button>
  );
}

export function WebcamPanel() {
  const { project, updateWebcamOverlay } = useProjectStore();

  const [ratioWidthInput, setRatioWidthInput] = useState('3');
  const [ratioHeightInput, setRatioHeightInput] = useState('4');
  const [sizePercentInput, setSizePercentInput] = useState('34');
  const [showCustomSettings, setShowCustomSettings] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  if (!project) {
    return null;
  }

  const webcamSourcePath = project.webcamOverlay?.sourcePath;
  const canEditWebcam = Boolean(webcamSourcePath);
  const isWebcamEnabled = Boolean(project.webcamOverlay?.enabled && canEditWebcam);

  const currentAspectRatio = useMemo(() => {
    const value = project.webcamOverlay?.aspectRatio;
    return Number.isFinite(value) && (value as number) > 0
      ? (value as number)
      : DEFAULT_WEBCAM_ASPECT_RATIO;
  }, [project.webcamOverlay?.aspectRatio]);

  const currentHeightRatio = useMemo(() => {
    const value = project.webcamOverlay?.heightRatio;
    return Number.isFinite(value) && (value as number) > 0
      ? (value as number)
      : DEFAULT_WEBCAM_HEIGHT_RATIO;
  }, [project.webcamOverlay?.heightRatio]);

  const currentShape = useMemo(
    () => resolveWebcamShape(project.webcamOverlay?.shape, currentAspectRatio),
    [currentAspectRatio, project.webcamOverlay?.shape],
  );

  const currentSizeOption = useMemo(
    () => resolveWebcamSizeOption(project.webcamOverlay?.size, currentHeightRatio),
    [currentHeightRatio, project.webcamOverlay?.size],
  );

  useEffect(() => {
    const parts = ratioToParts(currentAspectRatio);
    setRatioWidthInput(parts.widthPart);
    setRatioHeightInput(parts.heightPart);
  }, [currentAspectRatio]);

  useEffect(() => {
    setSizePercentInput((currentHeightRatio * 100).toFixed(1));
  }, [currentHeightRatio]);

  const handleWebcamToggle = (checked: boolean) => {
    if (!canEditWebcam) {
      return;
    }

    void updateWebcamOverlay({ enabled: checked });
  };

  const handleShapePresetChange = (value: WebcamOverlayShape) => {
    if (!canEditWebcam) {
      return;
    }

    setValidationMessage(null);
    void updateWebcamOverlay({
      shape: value,
      aspectRatio: SHAPE_ASPECT_RATIO[value],
      borderRadiusPx: DEFAULT_WEBCAM_BORDER_RADIUS_PX,
    });
  };

  const handleSizePresetChange = (value: WebcamSizeOption) => {
    if (!canEditWebcam) {
      return;
    }

    if (value === 'custom') {
      setShowCustomSettings(true);
      setValidationMessage(null);
      void updateWebcamOverlay({ size: undefined });
      return;
    }

    setShowCustomSettings(false);
    setValidationMessage(null);
    void updateWebcamOverlay({
      size: value,
      heightRatio: SIZE_HEIGHT_RATIO[value],
    });
  };

  const applyCustomAspectRatio = () => {
    if (!canEditWebcam) {
      return;
    }

    const widthPart = Number(ratioWidthInput);
    const heightPart = Number(ratioHeightInput);

    if (
      !Number.isFinite(widthPart) ||
      !Number.isFinite(heightPart) ||
      widthPart <= 0 ||
      heightPart <= 0
    ) {
      setValidationMessage('Aspect ratio values must be numbers greater than zero.');
      return;
    }

    const nextAspectRatio = clamp(widthPart / heightPart, MIN_ASPECT_RATIO, MAX_ASPECT_RATIO);
    const nextShape = shapeFromAspectRatio(nextAspectRatio);

    setValidationMessage(null);
    void updateWebcamOverlay({
      shape: nextShape,
      aspectRatio: nextAspectRatio,
      borderRadiusPx: DEFAULT_WEBCAM_BORDER_RADIUS_PX,
    });
  };

  const applyCustomSize = () => {
    if (!canEditWebcam) {
      return;
    }

    const sizePercent = Number(sizePercentInput);
    if (!Number.isFinite(sizePercent) || sizePercent <= 0) {
      setValidationMessage('Size must be a number greater than zero.');
      return;
    }

    const clampedPercent = clamp(sizePercent, MIN_SIZE_PERCENT, MAX_SIZE_PERCENT);
    const nextHeightRatio = clampedPercent / 100;

    setValidationMessage(null);
    void updateWebcamOverlay({
      size: undefined,
      heightRatio: nextHeightRatio,
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/70 bg-background px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Camera className="h-4 w-4" />
            </span>

            <div>
              <label className="text-sm font-medium">Webcam Overlay</label>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`text-[10px] font-semibold uppercase tracking-wide ${
                isWebcamEnabled ? 'text-emerald-500' : 'text-muted-foreground'
              }`}
            >
              {isWebcamEnabled ? 'On' : 'Off'}
            </span>
            <Switch
              checked={isWebcamEnabled}
              onCheckedChange={handleWebcamToggle}
              disabled={!canEditWebcam}
            />
          </div>
        </div>
      </div>

      {canEditWebcam && (
        <>
          <div className="space-y-2">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Shape
            </Label>

            <div className="flex flex-wrap gap-2">
              {SHAPE_OPTIONS.map((option) => (
                <IconPillOption
                  key={option.value}
                  label={option.label}
                  Icon={option.Icon}
                  iconClassName={option.iconClassName}
                  showLabel={false}
                  active={currentShape === option.value}
                  disabled={!canEditWebcam}
                  onClick={() => handleShapePresetChange(option.value)}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Size
            </Label>

            <div className="flex flex-wrap gap-2">
              {SIZE_OPTIONS.map((option) => (
                <IconPillOption
                  key={option.value}
                  label={option.label}
                  Icon={option.Icon}
                  iconClassName={option.iconClassName}
                  active={
                    option.value === 'custom'
                      ? showCustomSettings
                      : !showCustomSettings && currentSizeOption === option.value
                  }
                  disabled={!canEditWebcam}
                  onClick={() => handleSizePresetChange(option.value)}
                />
              ))}
            </div>
          </div>

          {showCustomSettings && (
            <div className="space-y-2 border-t border-border/60 pt-3">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <RectangleHorizontal className="h-3.5 w-3.5" />
                Custom Aspect Ratio (W:H)
              </div>

              <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
                <Input
                  value={ratioWidthInput}
                  onChange={(e) => setRatioWidthInput(e.target.value)}
                  className="h-8 text-xs"
                  inputMode="decimal"
                  placeholder="Width"
                />
                <span className="text-xs text-muted-foreground">:</span>
                <Input
                  value={ratioHeightInput}
                  onChange={(e) => setRatioHeightInput(e.target.value)}
                  className="h-8 text-xs"
                  inputMode="decimal"
                  placeholder="Height"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={applyCustomAspectRatio}
                >
                  Apply
                </Button>
              </div>
            </div>
          )}

          {showCustomSettings && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Custom Size (% of canvas height)
              </div>

              <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                <Input
                  value={sizePercentInput}
                  onChange={(e) => setSizePercentInput(e.target.value)}
                  className="h-8 text-xs"
                  inputMode="decimal"
                  placeholder="34"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={applyCustomSize}
                >
                  Apply
                </Button>
              </div>

              {validationMessage && <p className="text-xs text-destructive">{validationMessage}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
