/**
 * WebcamPanel
 *
 * Everything about the webcam lives here, including the per-region controls that
 * used to sit in the zoom panel. A webcam zoom region only ever expresses one
 * thing — how big the webcam is while it runs — but the data model offers three
 * overlapping ways to say it (zoomLevel, webcamHeightRatio, webcamFullScreen).
 * The mode picker below makes them exclusive so they can no longer contradict
 * each other:
 *
 *   Grow  -> webcamHeightRatio cleared, size derives from zoomLevel
 *   Exact -> webcamHeightRatio set, zoomLevel ignored for sizing
 *   Fill  -> webcamFullScreen, everything else ignored
 */

import { Dialog } from '@base-ui/react/dialog';
import {
  Camera,
  Circle,
  Copy,
  Loader2,
  QrCode,
  RectangleHorizontal,
  RectangleVertical,
  Smartphone,
  Square,
  VideoOff,
  X,
} from 'lucide-react';
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { getAnchorLabel, WEBCAM_ANCHORS } from '@/screens/editor/engine/webcam-anchor';
import { useProjectStore } from '@/store/project-store';
import { focusedZoomId, useTimelineStore } from '@/store/timeline-store';
import type {
  RemoteCameraState,
  WebcamOverlayAnchor,
  WebcamOverlayShape,
  WebcamOverlaySize,
  ZoomRegion,
} from '@/types';

import {
  OptionGrid,
  OptionTile,
  PANEL_LABEL,
  PanelButton,
  PanelEmpty,
  PanelNote,
  PanelRow,
  PanelSection,
  PanelSlider,
  Segmented,
} from './panel-kit';
import {
  GROW_ZOOM_CEILING,
  GROW_ZOOM_STEP,
  isGrowSaturated,
  MAX_HEIGHT_RATIO,
  MIN_HEIGHT_RATIO,
  type RegionSizeMode,
  resolveGrowMaxZoom,
  resolveRegionHeightRatio,
  resolveRegionSizeMode,
} from './webcam-region-sizing';

const DEFAULT_WEBCAM_ANCHOR: WebcamOverlayAnchor = 'bottom-right';
const DEFAULT_WEBCAM_SIZE: WebcamOverlaySize = 'medium';
const DEFAULT_WEBCAM_ASPECT_RATIO = 3 / 4;
const DEFAULT_WEBCAM_HEIGHT_RATIO = 0.34;
const DEFAULT_WEBCAM_BORDER_RADIUS_PX = 24;

const MIN_ASPECT_RATIO = 0.2;
const MAX_ASPECT_RATIO = 5;

type WebcamSizeOption = WebcamOverlaySize | 'custom';

interface IconOption<T extends string> {
  value: T;
  label: string;
  Icon: ComponentType<{ className?: string }>;
}

const SHAPE_OPTIONS: IconOption<WebcamOverlayShape>[] = [
  { value: 'circle', label: 'Circle', Icon: Circle },
  { value: 'rectangle-landscape', label: 'Wide', Icon: RectangleHorizontal },
  { value: 'rectangle-portrait', label: 'Tall', Icon: RectangleVertical },
  { value: 'square', label: 'Square', Icon: Square },
];

const SIZE_OPTIONS: { value: WebcamSizeOption; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'custom', label: 'Custom' },
];

function regionModeOptions(
  growIsSaturated: boolean,
): { value: RegionSizeMode; label: string; hint: string }[] {
  return [
    {
      value: 'grow',
      label: 'Grow',
      hint: growIsSaturated
        ? 'Unavailable: the webcam is already at its maximum size'
        : 'Scale the webcam by the zoom level',
    },
    { value: 'exact', label: 'Exact', hint: 'Pin the webcam to a specific size' },
    { value: 'fill', label: 'Fill frame', hint: 'Webcam takes over the whole canvas' },
  ];
}

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

/**
 * The phone-as-webcam flow is UI-only for now: there is no signalling service, no
 * WebRTC transport and no IPC behind it (see
 * implementation-plans/remote-camera-integration.md for what still has to be built),
 * so pairing would hand the user a QR code and link that never connect and then sit
 * on "Pairing" forever. The state and handlers stay wired up so the feature can be
 * finished without re-plumbing it — only the entry points are hidden. Flip this to
 * true once the transport lands.
 */
const SHOW_REMOTE_CAMERA = false;

type RemoteCameraTone = 'neutral' | 'active' | 'error';

function resolveRemoteCameraStatusLabel(state: RemoteCameraState): string {
  switch (state.status) {
    case 'pairing':
      return 'Pairing';
    case 'connecting':
      return 'Connecting';
    case 'connected':
      return 'Connected';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
}

function resolveRemoteCameraTone(state: RemoteCameraState): RemoteCameraTone {
  switch (state.status) {
    case 'connected':
    case 'pairing':
    case 'connecting':
      return 'active';
    case 'error':
      return 'error';
    default:
      return 'neutral';
  }
}

function formatExpiryLabel(expiresAt?: number): string | null {
  if (!Number.isFinite(expiresAt)) {
    return null;
  }

  const deltaMs = Math.max(0, (expiresAt as number) - Date.now());
  const totalSeconds = Math.round(deltaMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `Expires in ${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function WebcamPanel() {
  const {
    project,
    updateWebcamOverlay,
    remoteCamera,
    startRemoteCameraPairing,
    cancelRemoteCameraPairing,
  } = useProjectStore();
  const { zoomRegionsBySource, focus, updateZoom, updateZoomRegions } = useTimelineStore();
  const selectedZoomId = focusedZoomId(focus);

  const [ratioWidthInput, setRatioWidthInput] = useState('3');
  const [ratioHeightInput, setRatioHeightInput] = useState('4');
  const [showCustomSettings, setShowCustomSettings] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [localRegionZoom, setLocalRegionZoom] = useState(1.5);
  const [localRegionSize, setLocalRegionSize] = useState(DEFAULT_WEBCAM_HEIGHT_RATIO);
  const regionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const webcamRegions = zoomRegionsBySource.webcam;
  const selectedRegion = webcamRegions.find((region) => region.id === selectedZoomId);

  const currentAspectRatio = useMemo(() => {
    const value = project?.webcamOverlay?.aspectRatio;
    return Number.isFinite(value) && (value as number) > 0
      ? (value as number)
      : DEFAULT_WEBCAM_ASPECT_RATIO;
  }, [project?.webcamOverlay?.aspectRatio]);

  const currentHeightRatio = useMemo(() => {
    const value = project?.webcamOverlay?.heightRatio;
    return Number.isFinite(value) && (value as number) > 0
      ? (value as number)
      : DEFAULT_WEBCAM_HEIGHT_RATIO;
  }, [project?.webcamOverlay?.heightRatio]);

  const currentShape = useMemo(
    () => resolveWebcamShape(project?.webcamOverlay?.shape, currentAspectRatio),
    [currentAspectRatio, project?.webcamOverlay?.shape],
  );

  const currentSizeOption = useMemo(
    () => resolveWebcamSizeOption(project?.webcamOverlay?.size, currentHeightRatio),
    [currentHeightRatio, project?.webcamOverlay?.size],
  );

  const regionMode = resolveRegionSizeMode(selectedRegion);

  const growMaxZoom = useMemo(() => resolveGrowMaxZoom(currentHeightRatio), [currentHeightRatio]);
  /** True when the base size already sits at the ceiling, so Grow has nowhere to go. */
  const growIsSaturated = isGrowSaturated(currentHeightRatio);
  /** The stored zoom can exceed the usable range on an older region; show what actually applies. */
  const growZoom = clamp(localRegionZoom, 1, growMaxZoom);

  const growHint = useMemo(() => {
    const reachedPct = Math.round(
      clamp(currentHeightRatio * growZoom, MIN_HEIGHT_RATIO, MAX_HEIGHT_RATIO) * 100,
    );

    if (growMaxZoom < GROW_ZOOM_CEILING) {
      return `Webcam reaches ${reachedPct}% of canvas height. From a ${Math.round(
        currentHeightRatio * 100,
      )}% base, ${growMaxZoom.toFixed(1)}x is as far as it goes before the ${Math.round(
        MAX_HEIGHT_RATIO * 100,
      )}% ceiling.`;
    }

    return `Webcam reaches ${reachedPct}% of canvas height.`;
  }, [currentHeightRatio, growMaxZoom, growZoom]);

  const exactHint = useMemo(() => {
    const basePct = Math.round(currentHeightRatio * 100);
    const targetPct = Math.round(localRegionSize * 100);

    if (targetPct === basePct) {
      return `Same as the ${basePct}% base size — the webcam holds still through this region.`;
    }

    const multiplier = localRegionSize / Math.max(currentHeightRatio, 0.0001);
    const direction = targetPct > basePct ? 'Grows' : 'Shrinks';

    return `${direction} from the ${basePct}% base to ${targetPct}% (${multiplier.toFixed(2)}x).`;
  }, [currentHeightRatio, localRegionSize]);

  useEffect(() => {
    const parts = ratioToParts(currentAspectRatio);
    setRatioWidthInput(parts.widthPart);
    setRatioHeightInput(parts.heightPart);
  }, [currentAspectRatio]);

  useEffect(() => {
    if (selectedRegion) {
      setLocalRegionZoom(selectedRegion.zoomLevel);
      setLocalRegionSize(resolveRegionHeightRatio(selectedRegion, currentHeightRatio));
    }
  }, [
    selectedRegion?.id,
    selectedRegion?.zoomLevel,
    selectedRegion?.webcamHeightRatio,
    selectedRegion?.webcamFullScreen,
    currentHeightRatio,
  ]);

  useEffect(() => {
    if (remoteCamera.status === 'pairing' || remoteCamera.status === 'connecting') {
      setPairingOpen(true);
      return;
    }

    if (remoteCamera.status === 'idle' || remoteCamera.status === 'connected') {
      setPairingOpen(false);
    }
  }, [remoteCamera.status]);

  useEffect(() => {
    return () => {
      if (regionDebounceRef.current) {
        clearTimeout(regionDebounceRef.current);
      }
    };
  }, []);

  const commitRegion = useCallback(
    (patch: Partial<ZoomRegion>, immediate = false) => {
      if (!selectedRegion) {
        return;
      }

      const next = { ...selectedRegion, ...patch };

      if (regionDebounceRef.current) {
        clearTimeout(regionDebounceRef.current);
        regionDebounceRef.current = null;
      }

      if (immediate) {
        void updateZoom(next, 'webcam');
        return;
      }

      regionDebounceRef.current = setTimeout(() => {
        void updateZoom(next, 'webcam');
      }, 150);
    },
    [selectedRegion, updateZoom],
  );

  const handleRegionModeChange = useCallback(
    (mode: RegionSizeMode) => {
      if (!selectedRegion) {
        return;
      }

      // Each mode owns exactly one field; the others are cleared so the engine
      // cannot fall back to a stale value the UI is no longer showing.
      if (mode === 'fill') {
        commitRegion({ webcamFullScreen: true }, true);
        return;
      }

      if (mode === 'exact') {
        commitRegion(
          {
            webcamFullScreen: false,
            webcamHeightRatio: resolveRegionHeightRatio(selectedRegion, currentHeightRatio),
          },
          true,
        );
        return;
      }

      commitRegion({ webcamFullScreen: false, webcamHeightRatio: undefined }, true);
    },
    [commitRegion, currentHeightRatio, selectedRegion],
  );

  const handleApplyRegionToAll = useCallback(() => {
    if (!selectedRegion || webcamRegions.length <= 1) {
      return;
    }

    const updated = webcamRegions
      .filter((region) => region.id !== selectedRegion.id)
      .map((region) => ({
        ...region,
        zoomLevel: selectedRegion.zoomLevel,
        webcamHeightRatio: selectedRegion.webcamHeightRatio,
        webcamFullScreen: selectedRegion.webcamFullScreen,
      }));

    void updateZoomRegions(updated, 'webcam');
  }, [selectedRegion, updateZoomRegions, webcamRegions]);

  if (!project) {
    return null;
  }

  const webcamSourcePath = project.webcamOverlay?.sourcePath;
  const canEditWebcam = Boolean(webcamSourcePath);
  const isWebcamEnabled = Boolean(project.webcamOverlay?.enabled && canEditWebcam);
  const currentAnchor = project.webcamOverlay?.anchor ?? DEFAULT_WEBCAM_ANCHOR;

  const handleWebcamToggle = (checked: boolean) => {
    if (!canEditWebcam) {
      return;
    }

    void updateWebcamOverlay({ enabled: checked });
  };

  const handleAnchorChange = (value: WebcamOverlayAnchor) => {
    if (!canEditWebcam) {
      return;
    }

    setValidationMessage(null);
    void updateWebcamOverlay({ anchor: value });
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

  const handleCustomSizeChange = (percent: number) => {
    if (!canEditWebcam) {
      return;
    }

    void updateWebcamOverlay({
      size: undefined,
      heightRatio: clamp(percent / 100, MIN_HEIGHT_RATIO, MAX_HEIGHT_RATIO),
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

    setValidationMessage(null);
    void updateWebcamOverlay({
      shape: shapeFromAspectRatio(nextAspectRatio),
      aspectRatio: nextAspectRatio,
      borderRadiusPx: DEFAULT_WEBCAM_BORDER_RADIUS_PX,
    });
  };

  const isPairing = remoteCamera.status === 'pairing' || remoteCamera.status === 'connecting';
  const isConnected = remoteCamera.status === 'connected';
  const remoteTone = resolveRemoteCameraTone(remoteCamera);
  const remoteStatusLabel = resolveRemoteCameraStatusLabel(remoteCamera);
  const remoteExpiryLabel = formatExpiryLabel(remoteCamera.expiresAt);

  const handleStartPairing = () => {
    void startRemoteCameraPairing();
  };

  const handleCancelPairing = () => {
    void cancelRemoteCameraPairing();
  };

  const handlePairingOpenChange = (open: boolean) => {
    setPairingOpen(open);
    if (!open && isPairing) {
      void cancelRemoteCameraPairing();
    }
  };

  const handleCopyPairingUrl = async () => {
    if (!remoteCamera.pairingUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(remoteCamera.pairingUrl);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 2000);
    }
  };

  const copyLabel =
    copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy link';

  if (!canEditWebcam) {
    return (
      <PanelEmpty
        Icon={VideoOff}
        title="No webcam recorded"
        hint="This project has no webcam track, so there is nothing to overlay."
      />
    );
  }

  return (
    <>
      <PanelRow
        label="Webcam overlay"
        hint={isWebcamEnabled ? 'Shown on the canvas' : 'Hidden from the canvas'}
        control={<Switch checked={isWebcamEnabled} onCheckedChange={handleWebcamToggle} />}
      />

      {isWebcamEnabled && (
        <>
          <PanelSection
            title="Position"
            action={<span className={PANEL_LABEL}>{getAnchorLabel(currentAnchor)}</span>}
          >
            {/* The frame stands in for the video; each dot is a placement slot. */}
            <div
              className="grid aspect-video w-full grid-cols-3 grid-rows-3 rounded-[12px] border border-white/[0.07] bg-black/30 p-1.5"
              role="radiogroup"
              aria-label="Webcam position"
            >
              {WEBCAM_ANCHORS.map((anchorOption) => {
                const isActive = currentAnchor === anchorOption;

                return (
                  <button
                    key={anchorOption}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    aria-label={getAnchorLabel(anchorOption)}
                    title={getAnchorLabel(anchorOption)}
                    className="group grid cursor-pointer place-items-center rounded-[8px] transition-colors hover:bg-white/[0.06]"
                    onClick={() => handleAnchorChange(anchorOption)}
                  >
                    <span
                      className={cn(
                        'rounded-full transition-all duration-150',
                        isActive
                          ? 'size-2.5 bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
                          : 'size-1.5 bg-white/25 group-hover:bg-white/60',
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </PanelSection>

          <PanelSection title="Shape">
            <OptionGrid columns={4}>
              {SHAPE_OPTIONS.map((option) => (
                <OptionTile
                  key={option.value}
                  label={option.label}
                  Icon={option.Icon}
                  active={currentShape === option.value}
                  onClick={() => handleShapePresetChange(option.value)}
                />
              ))}
            </OptionGrid>
          </PanelSection>

          <PanelSection title="Size">
            <Segmented
              options={SIZE_OPTIONS}
              value={showCustomSettings ? 'custom' : currentSizeOption}
              onChange={handleSizePresetChange}
            />

            {(showCustomSettings || currentSizeOption === 'custom') && (
              <div className="space-y-3 rounded-[14px] border border-white/[0.07] bg-white/[0.025] p-3">
                <PanelSlider
                  label="Height"
                  value={Math.round(currentHeightRatio * 100)}
                  min={MIN_HEIGHT_RATIO * 100}
                  max={MAX_HEIGHT_RATIO * 100}
                  step={1}
                  onChange={handleCustomSizeChange}
                  format={(value) => `${Math.round(value)}% of canvas`}
                />

                <div className="space-y-1.5">
                  <span className={cn(PANEL_LABEL, 'block')}>Aspect ratio</span>
                  <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
                    <Input
                      value={ratioWidthInput}
                      onChange={(event) => setRatioWidthInput(event.target.value)}
                      className="h-8 text-xs"
                      inputMode="decimal"
                      placeholder="Width"
                      aria-label="Aspect ratio width"
                    />
                    <span className="text-xs text-white/35">:</span>
                    <Input
                      value={ratioHeightInput}
                      onChange={(event) => setRatioHeightInput(event.target.value)}
                      className="h-8 text-xs"
                      inputMode="decimal"
                      placeholder="Height"
                      aria-label="Aspect ratio height"
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

                {validationMessage && (
                  <p className="text-[11px] text-red-300">{validationMessage}</p>
                )}
              </div>
            )}

            <PanelNote>Drag the grip on the preview to resize the webcam directly.</PanelNote>
          </PanelSection>

          <PanelSection
            title="Webcam region"
            action={
              webcamRegions.length > 0 ? (
                <span className={PANEL_LABEL}>{webcamRegions.length} on timeline</span>
              ) : undefined
            }
          >
            {selectedRegion ? (
              <>
                <Segmented
                  options={regionModeOptions(growIsSaturated)}
                  value={regionMode}
                  onChange={handleRegionModeChange}
                />

                {regionMode === 'grow' && (
                  <>
                    <PanelSlider
                      label="Zoom level"
                      value={growZoom}
                      min={1}
                      max={growIsSaturated ? 2 : growMaxZoom}
                      step={GROW_ZOOM_STEP}
                      disabled={growIsSaturated}
                      onChange={(value) => {
                        const next = clamp(value, 1, growMaxZoom);
                        setLocalRegionZoom(next);
                        commitRegion({ zoomLevel: next });
                      }}
                      format={(value) => `${value.toFixed(1)}x`}
                      hint={growIsSaturated ? undefined : growHint}
                    />

                    {growIsSaturated && (
                      <PanelNote>
                        Grow scales the base size, but at {Math.round(currentHeightRatio * 100)}% it
                        leaves no usable room under the {Math.round(MAX_HEIGHT_RATIO * 100)}% canvas
                        height ceiling. Shrink the base size above, switch to Exact to pick a size
                        directly, or use Fill frame to cover the whole canvas.
                      </PanelNote>
                    )}
                  </>
                )}

                {regionMode === 'exact' && (
                  <PanelSlider
                    label="Webcam height"
                    value={Math.round(localRegionSize * 100)}
                    min={MIN_HEIGHT_RATIO * 100}
                    max={MAX_HEIGHT_RATIO * 100}
                    step={1}
                    marker={{ value: Math.round(currentHeightRatio * 100), label: 'Base' }}
                    onChange={(value) => {
                      const ratio = clamp(value / 100, MIN_HEIGHT_RATIO, MAX_HEIGHT_RATIO);
                      setLocalRegionSize(ratio);
                      commitRegion({ webcamHeightRatio: ratio });
                    }}
                    format={(value) => `${Math.round(value)}% of canvas`}
                    hint={exactHint}
                  />
                )}

                {regionMode === 'fill' && (
                  <PanelNote>
                    The webcam eases up to cover the whole canvas for this region, then back down.
                  </PanelNote>
                )}

                {webcamRegions.length > 1 && (
                  <PanelButton onClick={handleApplyRegionToAll}>
                    Apply to all {webcamRegions.length} regions
                  </PanelButton>
                )}
              </>
            ) : (
              <PanelEmpty
                Icon={Camera}
                title="No webcam region selected"
                hint="Double-click the webcam zoom lane on the timeline to add one."
              />
            )}
          </PanelSection>
        </>
      )}

      {SHOW_REMOTE_CAMERA && (
        <PanelSection title="Phone as webcam">
          <PanelRow
            label="Use your phone"
            hint={remoteStatusLabel}
            control={
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'rounded-full px-2 py-1 text-[10px] font-[750] uppercase tracking-wide',
                    remoteTone === 'active'
                      ? 'bg-emerald-400/15 text-emerald-300'
                      : remoteTone === 'error'
                        ? 'bg-red-500/15 text-red-300'
                        : 'bg-white/[0.06] text-white/45',
                  )}
                >
                  {remoteStatusLabel}
                </span>
                <Button size="sm" onClick={handleStartPairing} disabled={isPairing || isConnected}>
                  <Smartphone className="size-3.5" />
                  {isConnected ? 'Connected' : 'Pair'}
                </Button>
              </div>
            }
          />
          {remoteCamera.error && <p className="text-[11px] text-red-300">{remoteCamera.error}</p>}
        </PanelSection>
      )}

      {SHOW_REMOTE_CAMERA && (
        <Dialog.Root open={pairingOpen} onOpenChange={handlePairingOpenChange}>
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-starting-style:opacity-0 data-ending-style:opacity-0 transition-opacity duration-200" />
            <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-6 shadow-xl data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 transition-all duration-200">
              <div className="mb-4 flex items-center justify-between">
                <Dialog.Title className="text-lg font-semibold">Connect phone camera</Dialog.Title>
                <Dialog.Close className="text-muted-foreground transition-colors hover:text-foreground">
                  <X className="h-5 w-5" />
                </Dialog.Close>
              </div>

              <div className="grid gap-4 md:grid-cols-[200px_1fr]">
                <div className="flex flex-col items-center gap-3">
                  <div className="flex h-44 w-44 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 text-muted-foreground">
                    {remoteCamera.qrDataUrl ? (
                      <img
                        src={remoteCamera.qrDataUrl}
                        alt="Pairing QR code"
                        className="h-40 w-40 rounded-md"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-2 text-xs">
                        <QrCode className="h-5 w-5" />
                        QR code
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">Scan with your phone</span>
                </div>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Pairing link</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        readOnly
                        value={remoteCamera.pairingUrl ?? 'Generating pairing link...'}
                        className="h-9 text-xs"
                      />
                      <Button size="sm" variant="outline" onClick={handleCopyPairingUrl}>
                        <Copy className="h-3.5 w-3.5" />
                        {copyLabel}
                      </Button>
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Open the link on your phone, allow camera access, and keep this window open.
                  </p>

                  <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      {isPairing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Camera className="h-3.5 w-3.5" />
                      )}
                      <span>{remoteStatusLabel}</span>
                    </div>
                    {remoteExpiryLabel && (
                      <span className="text-muted-foreground">{remoteExpiryLabel}</span>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={handleStartPairing} disabled={isPairing}>
                      Regenerate link
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleCancelPairing}>
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}
