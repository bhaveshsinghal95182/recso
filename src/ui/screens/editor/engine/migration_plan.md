These are all the types in the new engine I want

export interface GradientStop {
color: string;
position: number;
}

// ── Background ─────────────────────────────────────────

export interface BackgroundConfig {
enabled: boolean;
/\*\*

- 'color' – solid fill
- 'linearGradient' – angle + stops
- 'radialGradient' – elliptical radial gradient (maps to user's first CSS example)
- 'crossHatch' – diagonal cross pattern with optional radial fade mask
-                    (maps to user's second CSS example)
  \*/
  type: "color" | "linearGradient" | "radialGradient" | "crossHatch";

color?: string;
angle?: number;
stops?: GradientStop[];
cx?: number;
cy?: number;
radiusX?: number;
radiusY?: number;
backgroundColor?: string;
lineColor?: string;
lineWidth?: number;
cellSize?: number;
mask?: {
cx: number;
cy: number;
rx: number;
ry: number;
innerStop: number;
outerStop: number;
};
}

// ── Video ──────────────────────────────────────────────

export interface VideoConfig {
scale: number;
borderRadius: number;
border: {
width: number;
color: string;
};
}

// ── Composition timelines/layout ──────────────────────

export interface CompositionLayout {
/** X offset on the canvas \*/
x: number;
/** Y offset on the canvas _/
y: number;
/\*\* Rendered width on canvas _/
width: number;
/** Rendered height on canvas \*/
height: number;
/** Scale factor applied (1.0 = original size) \*/
scale: number;
}

/\*_ A timestamped focal-point change within a zoom region _/
export interface CompositionFocalKeyframe {
timestampMs: number;
focalX: number;
focalY: number;
}

/** Zoom region data needed by the composition \*/
export interface CompositionZoomRegion {
id: string;
startMs: number;
endMs: number;
zoomLevel: number;
/** Initial focal point X (0-1, normalized) _/
focalX: number;
/\*\* Initial focal point Y (0-1, normalized) _/
focalY: number;
/** Ease duration in milliseconds \*/
easeDurationMs: number;
/** Optional focal-point keyframes for smart pan \*/
focalKeyframes?: CompositionFocalKeyframe[];
}

/** A region to cut (exclude) from the final video \*/
export interface CompositionCutRegion {
id: string;
/** Start of the cut in milliseconds (source timeline) _/
startMs: number;
/\*\* End of the cut in milliseconds (source timeline) _/
endMs: number;
}

export type BackgroundPatternConfig = BackgroundConfig;

/\*\*

- Props passed to Remotion composition at render time.
-
- This is the contract between the host (Player or Renderer) and the composition.
  _/
  export interface RemotionInputProps {
  /\*\* Index signature required by Remotion's LooseComponentType _/
  [key: string]: unknown;
  /\*_ Absolute path to the raw video file _/
  videoSrc: string;

/\*_ Background color (hex string like '#1a1a2e') _/
backgroundColor: string;

/\*_ Optional background image path _/
backgroundPath?: string;

/\*\*

- Optional CSS background pattern.
-
- Patterns can define their own container styles (bg color, text color),
- which can be overridden by `backgroundColor` if needed.
  \*/
  backgroundPattern?: BackgroundPatternConfig;

/\*_ Pre-calculated layout for video positioning on canvas _/
layout: CompositionLayout;

/\*_ Canvas dimensions _/
canvasWidth: number;
canvasHeight: number;

/\*_ Zoom regions to animate _/
zoomRegions: CompositionZoomRegion[];

/\*_ Cut regions to exclude (frame-skipped in composition) _/
cuts?: CompositionCutRegion[];

/\*_ Original source video duration in ms (before cuts) _/
sourceDurationMs?: number;
}

// ── Zoom keyframes ─────────────────────────────────────

export interface ZoomKeyframe {
startTime: number;
endTime: number;
focalPoint: { x: number; y: number };
multiplier: number;
easeIn?: number;
easeOut?: number;
}

// ── Root config ────────────────────────────────────────

export interface CompositionConfig {
background: BackgroundConfig;
video: VideoConfig;
layout?: CompositionLayout;
zooms: ZoomKeyframe[];
zoomRegions?: CompositionZoomRegion[];
cuts?: CompositionCutRegion[];
}

export type Canvas2DContext =
| CanvasRenderingContext2D
| OffscreenCanvasRenderingContext2D;

export interface FrameVideoSource {
draw(
ctx: Canvas2DContext,
x: number,
y: number,
width: number,
height: number,
): void;
}

export interface VideoLayout {
x: number;
y: number;
width: number;
height: number;
scale: number;
}

export interface ZoomState {
scale: number;
pivotX: number;
pivotY: number;
}

These are all the functions that needs to be used to make and edit the videos

export function roundRectPath(
ctx: Canvas2DContext,
x: number,
y: number,
width: number,
height: number,
radius: number,
): void {
const clamped = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
ctx.beginPath();
ctx.moveTo(x + clamped, y);
ctx.lineTo(x + width - clamped, y);
ctx.quadraticCurveTo(x + width, y, x + width, y + clamped);
ctx.lineTo(x + width, y + height - clamped);
ctx.quadraticCurveTo(x + width, y + height, x + width - clamped, y + height);
ctx.lineTo(x + clamped, y + height);
ctx.quadraticCurveTo(x, y + height, x, y + height - clamped);
ctx.lineTo(x, y + clamped);
ctx.quadraticCurveTo(x, y, x + clamped, y);
ctx.closePath();
}

export function computeVideoLayout(
frameWidth: number,
frameHeight: number,
config: CompositionConfig,
): VideoLayout {
if (config.layout) {
return {
x: config.layout.x,
y: config.layout.y,
width: config.layout.width,
height: config.layout.height,
scale: config.layout.scale,
};
}

const videoScale = config.background.enabled ? config.video.scale : 1;
const width = frameWidth _ videoScale;
const height = frameHeight _ videoScale;
const x = (frameWidth - width) / 2;
const y = (frameHeight - height) / 2;

return { x, y, width, height, scale: videoScale };
}

function clampNormalised(value: number): number {
if (!Number.isFinite(value)) {
return 0;
}
return Math.max(0, Math.min(1, value));
}

function normaliseCuts(cuts: CompositionCutRegion[]): CompositionCutRegion[] {
const sorted = [...cuts]
.map((cut) => ({
...cut,
startMs: Math.max(0, cut.startMs),
endMs: Math.max(0, cut.endMs),
}))
.filter((cut) => cut.endMs > cut.startMs)
.sort((a, b) => a.startMs - b.startMs);

const merged: CompositionCutRegion[] = [];
for (const cut of sorted) {
const previous = merged[merged.length - 1];
if (previous && cut.startMs <= previous.endMs) {
previous.endMs = Math.max(previous.endMs, cut.endMs);
continue;
}

    merged.push({ ...cut });

}

return merged;
}

function getCutDurationBeforeTimeMs(
timestampMs: number,
cuts?: CompositionCutRegion[],
): number {
if (!cuts?.length) {
return 0;
}

let skippedMs = 0;
for (const cut of normaliseCuts(cuts)) {
if (timestampMs <= cut.startMs) {
break;
}

    const cutEnd = Math.min(timestampMs, cut.endMs);
    if (cutEnd > cut.startMs) {
      skippedMs += cutEnd - cut.startMs;
    }

}

return skippedMs;
}

export function isInCutRegion(
timestampMs: number,
cuts?: CompositionCutRegion[],
): boolean {
if (!cuts?.length) {
return false;
}

for (const cut of normaliseCuts(cuts)) {
if (timestampMs >= cut.startMs && timestampMs < cut.endMs) {
return true;
}
}

return false;
}

export function mapCompositionToSourceTimeMs(
compositionTimeMs: number,
cuts?: CompositionCutRegion[],
): number {
if (!cuts?.length) {
return Math.max(0, compositionTimeMs);
}

let sourceMs = Math.max(0, compositionTimeMs);
for (const cut of normaliseCuts(cuts)) {
if (sourceMs < cut.startMs) {
break;
}

    sourceMs += cut.endMs - cut.startMs;

}

return sourceMs;
}

export function mapSourceTimeToCompositionTimeMs(
sourceTimeMs: number,
cuts?: CompositionCutRegion[],
): number {
const safeTimeMs = Math.max(0, sourceTimeMs);
return Math.max(0, safeTimeMs - getCutDurationBeforeTimeMs(safeTimeMs, cuts));
}

export function getCutAdjustedDurationMs(
sourceDurationMs: number,
cuts?: CompositionCutRegion[],
): number {
const safeDurationMs = Math.max(0, sourceDurationMs);
if (!cuts?.length) {
return safeDurationMs;
}

return Math.max(
0,
safeDurationMs - getCutDurationBeforeTimeMs(safeDurationMs, cuts),
);
}

function resolveRegionFocalPoint(
region: CompositionZoomRegion,
timestampMs: number,
): { x: number; y: number } {
const keyframes = region.focalKeyframes ?? [];
if (keyframes.length === 0) {
return {
x: clampNormalised(region.focalX),
y: clampNormalised(region.focalY),
};
}

const points = [
{
timestampMs: region.startMs,
focalX: clampNormalised(region.focalX),
focalY: clampNormalised(region.focalY),
},
...keyframes
.map((point) => ({
timestampMs: point.timestampMs,
focalX: clampNormalised(point.focalX),
focalY: clampNormalised(point.focalY),
}))
.sort((a, b) => a.timestampMs - b.timestampMs),
];

if (timestampMs <= points[0].timestampMs) {
return { x: points[0].focalX, y: points[0].focalY };
}

const lastPoint = points[points.length - 1];
if (timestampMs >= lastPoint.timestampMs) {
return { x: lastPoint.focalX, y: lastPoint.focalY };
}

for (let index = 0; index < points.length - 1; index += 1) {
const current = points[index];
const next = points[index + 1];

    if (timestampMs >= current.timestampMs && timestampMs <= next.timestampMs) {
      const range = next.timestampMs - current.timestampMs;
      if (range <= 0) {
        return { x: current.focalX, y: current.focalY };
      }

      const mix = (timestampMs - current.timestampMs) / range;
      return {
        x: lerp(current.focalX, next.focalX, mix),
        y: lerp(current.focalY, next.focalY, mix),
      };
    }

}

return { x: lastPoint.focalX, y: lastPoint.focalY };
}

export function computeZoomStateFromRegions(
timestampMs: number,
zoomRegions: CompositionZoomRegion[],
frameWidth: number,
frameHeight: number,
): ZoomState {
let scale = 1;
let pivotX = frameWidth / 2;
let pivotY = frameHeight / 2;

for (const region of zoomRegions) {
if (timestampMs >= region.startMs && timestampMs <= region.endMs) {
const easeDurationMs = Math.max(0, region.easeDurationMs);
let eased = 1;

      if (easeDurationMs > 0 && timestampMs < region.startMs + easeDurationMs) {
        eased = smoothstep((timestampMs - region.startMs) / easeDurationMs);
      } else if (
        easeDurationMs > 0 &&
        timestampMs > region.endMs - easeDurationMs
      ) {
        eased = smoothstep((region.endMs - timestampMs) / easeDurationMs);
      }

      scale = 1 + (region.zoomLevel - 1) * eased;
      const focal = resolveRegionFocalPoint(region, timestampMs);
      pivotX = focal.x * frameWidth;
      pivotY = focal.y * frameHeight;
      break;
    }

}

return { scale, pivotX, pivotY };
}

export function computeZoomState(
t: number,
zooms: ZoomKeyframe[],
frameWidth: number,
frameHeight: number,
): ZoomState {
let scale = 1;
let pivotX = frameWidth / 2;
let pivotY = frameHeight / 2;

for (const zoom of zooms) {
if (t >= zoom.startTime && t <= zoom.endTime) {
const easeIn = zoom.easeIn ?? 0.3;
const easeOut = zoom.easeOut ?? 0.3;
let eased = 1;

      if (t < zoom.startTime + easeIn && easeIn > 0) {
        eased = smoothstep((t - zoom.startTime) / easeIn);
      } else if (t > zoom.endTime - easeOut && easeOut > 0) {
        eased = smoothstep((zoom.endTime - t) / easeOut);
      }

      scale = 1 + (zoom.multiplier - 1) * eased;
      pivotX = zoom.focalPoint.x * frameWidth;
      pivotY = zoom.focalPoint.y * frameHeight;
      break;
    }

}

return { scale, pivotX, pivotY };
}

export function computeZoomStateFromConfig(
t: number,
config: CompositionConfig,
frameWidth: number,
frameHeight: number,
): ZoomState {
if (config.zoomRegions && config.zoomRegions.length > 0) {
return computeZoomStateFromRegions(
t \* 1000,
config.zoomRegions,
frameWidth,
frameHeight,
);
}

return computeZoomState(t, config.zooms, frameWidth, frameHeight);
}

export function drawVideoLayer(
ctx: Canvas2DContext,
layout: VideoLayout,
videoConfig: VideoConfig,
source: FrameVideoSource,
): void {
if (videoConfig.borderRadius > 0 || videoConfig.border.width > 0) {
ctx.save();

    if (videoConfig.border.width > 0) {
      const borderWidth = videoConfig.border.width;
      roundRectPath(
        ctx,
        layout.x - borderWidth,
        layout.y - borderWidth,
        layout.width + borderWidth * 2,
        layout.height + borderWidth * 2,
        videoConfig.borderRadius + borderWidth,
      );
      ctx.fillStyle = videoConfig.border.color;
      ctx.fill();
    }

    roundRectPath(
      ctx,
      layout.x,
      layout.y,
      layout.width,
      layout.height,
      videoConfig.borderRadius,
    );
    ctx.clip();

    source.draw(ctx, layout.x, layout.y, layout.width, layout.height);
    ctx.restore();
    return;

}

source.draw(ctx, layout.x, layout.y, layout.width, layout.height);
}

export interface RenderCompositionFrameOptions {
ctx: Canvas2DContext;
frameWidth: number;
frameHeight: number;
t: number;
config: CompositionConfig;
source: FrameVideoSource;
}

export function renderCompositionFrame({
ctx,
frameWidth,
frameHeight,
t,
config,
source,
}: RenderCompositionFrameOptions): void {
const zoomState = computeZoomStateFromConfig(
t,
config,
frameWidth,
frameHeight,
);
const videoLayout = computeVideoLayout(frameWidth, frameHeight, config);

ctx.save();
ctx.translate(zoomState.pivotX, zoomState.pivotY);
ctx.scale(zoomState.scale, zoomState.scale);
ctx.translate(-zoomState.pivotX, -zoomState.pivotY);

if (config.background.enabled) {
drawBackground(ctx, frameWidth, frameHeight, config.background);
} else {
ctx.clearRect(0, 0, frameWidth, frameHeight);
}

drawVideoLayer(ctx, videoLayout, config.video, source);
ctx.restore();
}

this is how all the above things are used in a basic preview

import { useEffect, useRef, useState, type DragEvent } from "react";
import {
ALL_FORMATS,
BlobSource,
BufferTarget,
Conversion,
Input,
Mp4OutputFormat,
Output,
} from "mediabunny";
import "./App.css";
import {
defaultConfig,
getCutAdjustedDurationMs,
isInCutRegion,
mapCompositionToSourceTimeMs,
mapSourceTimeToCompositionTimeMs,
type CompositionConfig,
} from "./compositionConfig";
import { CompositionConfigJsonEditor } from "./CompositionConfigJsonEditor";
import {
CanvasFrameContext,
createFrameCanvas,
HtmlVideoFrameSource,
MediabunnySampleSource,
type MediabunnyVideoSample,
PixiPreviewSurface,
} from "./engine/adapters";
import { CompositionEngine } from "./engine/engine";

function resolveSampleTimeSeconds(
timestamp: number | bigint | undefined,
frameIndex: number,
fallbackFps: number,
): number {
if (typeof timestamp === "bigint") {
const asNumber = Number(timestamp);
if (Number.isFinite(asNumber)) {
return asNumber / 1_000_000;
}
}

if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
if (timestamp > 1_000_000) {
return timestamp / 1_000_000;
}
if (timestamp > 1_000) {
return timestamp / 1_000;
}
return Math.max(0, timestamp);
}

return frameIndex / fallbackFps;
}

function parseCompositionConfigJson(rawJson: string): CompositionConfig {
const parsed = JSON.parse(rawJson) as unknown;

if (!parsed || typeof parsed !== "object") {
throw new Error("Top-level JSON value must be an object.");
}

const candidate = parsed as Partial<CompositionConfig>;
if (!candidate.background || !candidate.video || !Array.isArray(candidate.zooms)) {
throw new Error(
"JSON must include `background`, `video`, and `zooms` fields.",
);
}

return candidate as CompositionConfig;
}

function toConfigJson(config: CompositionConfig): string {
return JSON.stringify(config, null, 2);
}

function saveConfigJsonToFile(json: string): void {
const blob = new Blob([json], { type: "application/json" });
const url = URL.createObjectURL(blob);
const anchor = document.createElement("a");
anchor.href = url;
anchor.download = "composition-config.json";
anchor.click();
URL.revokeObjectURL(url);
}

function getCompositionDurationSeconds(
videoDurationSeconds: number | null | undefined,
cuts: CompositionConfig["cuts"],
): number | null {
if (
typeof videoDurationSeconds !== "number" ||
!Number.isFinite(videoDurationSeconds) ||
videoDurationSeconds <= 0
) {
return null;
}

return getCutAdjustedDurationMs(videoDurationSeconds \* 1000, cuts) / 1000;
}

export default function EditorMe() {
const [videoSrc, setVideoSrc] = useState<string | null>(null);
const [sourceFile, setSourceFile] = useState<File | null>(null);
const [isDragging, setIsDragging] = useState(false);
const [isPlaying, setIsPlaying] = useState(false);
const [playbackProgress, setPlaybackProgress] = useState(0);
const [isConverting, setIsConverting] = useState(false);
const [exportProgress, setExportProgress] = useState<number | null>(null);
const [error, setError] = useState<string | null>(null);
const [compositionConfig, setCompositionConfig] = useState<CompositionConfig>(
() => defaultConfig,
);
const [configDraftJson, setConfigDraftJson] = useState(() =>
toConfigJson(defaultConfig),
);
const [configEditorStatus, setConfigEditorStatus] = useState<string | null>(
"Loaded default composition config.",
);
const [configEditorError, setConfigEditorError] = useState<string | null>(
null,
);

const fileInputRef = useRef<HTMLInputElement>(null);
const videoRef = useRef<HTMLVideoElement>(null);
const previewCanvasRef = useRef<HTMLCanvasElement>(null);
const previewContextRef = useRef<CanvasFrameContext | null>(null);
const pixiSurfaceRef = useRef<PixiPreviewSurface | null>(null);
const rafRef = useRef<number | null>(null);
const engineRef = useRef<CompositionEngine>(
new CompositionEngine(defaultConfig),
);

const applyCompositionConfig = (
nextConfig: CompositionConfig,
statusMessage: string,
) => {
setCompositionConfig(nextConfig);
setConfigDraftJson(toConfigJson(nextConfig));
setConfigEditorError(null);
setConfigEditorStatus(statusMessage);
};

const handleApplyConfigJson = () => {
try {
const nextConfig = parseCompositionConfigJson(configDraftJson);
applyCompositionConfig(nextConfig, "Composition updated from JSON.");
} catch (applyError) {
setConfigEditorError(
applyError instanceof Error
? applyError.message
: "Failed to parse composition JSON.",
);
setConfigEditorStatus(null);
}
};

const handleFormatConfigJson = () => {
try {
const nextConfig = parseCompositionConfigJson(configDraftJson);
setConfigDraftJson(toConfigJson(nextConfig));
setConfigEditorError(null);
setConfigEditorStatus("JSON formatted. Apply to preview changes.");
} catch (formatError) {
setConfigEditorError(
formatError instanceof Error
? formatError.message
: "JSON format failed.",
);
setConfigEditorStatus(null);
}
};

const handleResetConfigJson = () => {
applyCompositionConfig(defaultConfig, "Reset to default composition config.");
};

const handleSaveConfigJson = () => {
saveConfigJsonToFile(configDraftJson);
setConfigEditorStatus("Config JSON saved as composition-config.json.");
setConfigEditorError(null);
};

useEffect(() => {
const engine = engineRef.current;
engine.setComposition(compositionConfig);

    const compositionDurationSeconds = getCompositionDurationSeconds(
      videoRef.current?.duration,
      compositionConfig.cuts,
    );
    if (compositionDurationSeconds !== null) {
      engine.setDuration(compositionDurationSeconds);
    }

}, [compositionConfig]);

useEffect(() => {
const engine = engineRef.current;

    return () => {
      engine.dispose();
    };

}, []);

useEffect(() => {
if (!videoSrc) {
return;
}

    const video = videoRef.current;
    const previewCanvas = previewCanvasRef.current;
    if (!video || !previewCanvas) {
      return;
    }

    const engine = engineRef.current;
    const pixiSurface = new PixiPreviewSurface();
    let cancelled = false;
    let initialized = false;

    const stopLoop = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    const renderLoop = (now: number) => {
      if (cancelled) {
        return;
      }

      const previewContext = previewContextRef.current;
      if (previewContext) {
        const state = engine.getTransportState();
        if (state.isPlaying) {
          const engineTime = engine.tick(now);
          const mappedSourceTime =
            mapCompositionToSourceTimeMs(
              engineTime * 1000,
              compositionConfig.cuts,
            ) / 1000;

          if (Math.abs(video.currentTime - mappedSourceTime) > 0.05) {
            video.currentTime = mappedSourceTime;
          }
        }

        const mappedCompositionTime =
          mapSourceTimeToCompositionTimeMs(
            video.currentTime * 1000,
            compositionConfig.cuts,
          ) / 1000;
        engine.seek(mappedCompositionTime);
        engine.renderCurrentFrame(previewContext);
        pixiSurface.present();
      }

      rafRef.current = requestAnimationFrame(renderLoop);
    };

    const initializePreview = async () => {
      if (cancelled || initialized) {
        return;
      }
      if (!video.videoWidth || !video.videoHeight) {
        return;
      }
      initialized = true;

      previewCanvas.width = video.videoWidth;
      previewCanvas.height = video.videoHeight;

      const compositionCanvas = document.createElement("canvas");
      compositionCanvas.width = video.videoWidth;
      compositionCanvas.height = video.videoHeight;

      previewContextRef.current = new CanvasFrameContext(compositionCanvas);
      const compositionDurationSeconds = getCompositionDurationSeconds(
        video.duration,
        compositionConfig.cuts,
      );
      engine.setDuration(compositionDurationSeconds);
      engine.setVideoSource(new HtmlVideoFrameSource(video));
      engine.seek(
        mapSourceTimeToCompositionTimeMs(
          video.currentTime * 1000,
          compositionConfig.cuts,
        ) / 1000,
      );

      await pixiSurface.init(previewCanvas, compositionCanvas);
      if (cancelled) {
        pixiSurface.destroy();
        return;
      }

      pixiSurfaceRef.current = pixiSurface;
      engine.renderCurrentFrame(previewContextRef.current);
      pixiSurface.present();
      rafRef.current = requestAnimationFrame(renderLoop);
    };

    const handleCanPlay = () => {
      void initializePreview();
    };

    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      void initializePreview();
    } else {
      video.addEventListener("canplay", handleCanPlay);
      video.addEventListener("loadedmetadata", handleCanPlay);
    }

    return () => {
      cancelled = true;
      stopLoop();
      video.removeEventListener("canplay", handleCanPlay);
      video.removeEventListener("loadedmetadata", handleCanPlay);
      engine.pause();
      engine.setVideoSource(null);
      previewContextRef.current = null;

      if (pixiSurfaceRef.current) {
        pixiSurfaceRef.current.destroy();
      }
      pixiSurfaceRef.current = null;
    };

}, [videoSrc, compositionConfig.cuts]);

useEffect(() => {
return () => {
if (videoSrc) {
URL.revokeObjectURL(videoSrc);
}

      if (pixiSurfaceRef.current) {
        pixiSurfaceRef.current.destroy();
      }

      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };

}, [videoSrc]);

const processFile = (file: File) => {
if (!file.type.startsWith("video/")) {
setError("Please drop a valid video file.");
return;
}

    if (videoSrc) {
      URL.revokeObjectURL(videoSrc);
    }

    setSourceFile(file);
    setVideoSrc(URL.createObjectURL(file));
    setError(null);
    setPlaybackProgress(0);
    setIsPlaying(false);
    engineRef.current.pause();
    engineRef.current.seek(0);

};

const handlePlayPause = () => {
const video = videoRef.current;
if (!video) {
return;
}

    if (video.paused) {
      engineRef.current.play(
        mapSourceTimeToCompositionTimeMs(
          video.currentTime * 1000,
          compositionConfig.cuts,
        ) / 1000,
      );
      void video.play();
      return;
    }

    video.pause();
    engineRef.current.pause();

};

const handleScrub = (event: React.MouseEvent<HTMLDivElement>) => {
const video = videoRef.current;
if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
return;
}

    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }

    const ratio = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / rect.width),
    );
    const compositionDurationSeconds = getCompositionDurationSeconds(
      video.duration,
      compositionConfig.cuts,
    );
    if (!compositionDurationSeconds) {
      return;
    }

    const nextCompositionTime = ratio * compositionDurationSeconds;
    const nextSourceTime =
      mapCompositionToSourceTimeMs(
        nextCompositionTime * 1000,
        compositionConfig.cuts,
      ) / 1000;

    video.currentTime = nextSourceTime;
    engineRef.current.seek(nextCompositionTime);
    setPlaybackProgress(ratio);

    const previewContext = previewContextRef.current;
    if (previewContext) {
      engineRef.current.renderCurrentFrame(previewContext);
      pixiSurfaceRef.current?.present();
    }

};

const handleExport = async () => {
if (!sourceFile) {
return;
}

    setIsConverting(true);
    setExportProgress(0);
    setError(null);

    try {
      const input = new Input({
        formats: ALL_FORMATS,
        source: new BlobSource(sourceFile),
      });

      const target = new BufferTarget();
      const output = new Output({
        format: new Mp4OutputFormat(),
        target,
      });

      const engine = engineRef.current;
      engine.setComposition(compositionConfig);

      let exportContext: CanvasFrameContext | null = null;
      let frameIndex = 0;
      const fallbackFps = 30;

      const conversion = await Conversion.init({
        input,
        output,
        video: {
          process: (sample: MediabunnyVideoSample) => {
            if (
              !exportContext ||
              exportContext.width !== sample.displayWidth ||
              exportContext.height !== sample.displayHeight
            ) {
              const frameCanvas = createFrameCanvas(
                sample.displayWidth,
                sample.displayHeight,
              );
              exportContext = new CanvasFrameContext(frameCanvas);
            }

            const frameTime = resolveSampleTimeSeconds(
              sample.timestamp,
              frameIndex,
              fallbackFps,
            );
            frameIndex += 1;

            const sourceTimeMs = frameTime * 1000;
            if (isInCutRegion(sourceTimeMs, compositionConfig.cuts)) {
              return null;
            }

            const compositionTimeSeconds =
              mapSourceTimeToCompositionTimeMs(
                sourceTimeMs,
                compositionConfig.cuts,
              ) / 1000;

            if (typeof sample.setTimestamp === "function") {
              sample.setTimestamp(compositionTimeSeconds);
            }

            engine.renderFrameAt(
              compositionTimeSeconds,
              exportContext,
              new MediabunnySampleSource(sample),
            );
            return exportContext.getCanvas();
          },
        },
      });

      conversion.onProgress = (progress: number) => {
        setExportProgress(progress);
      };

      if (!conversion.isValid) {
        setError("Cannot export this video.");
        setIsConverting(false);
        setExportProgress(null);
        return;
      }

      await conversion.execute();

      const blob = new Blob([target.buffer as ArrayBuffer], {
        type: "video/mp4",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "processed_video.mp4";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      console.error("Export error", exportError);
      setError("An error occurred during export.");
    } finally {
      setIsConverting(false);
      setTimeout(() => setExportProgress(null), 2000);
    }

};

const handleClose = () => {
if (videoSrc) {
URL.revokeObjectURL(videoSrc);
}
setVideoSrc(null);
setSourceFile(null);
setPlaybackProgress(0);
setIsPlaying(false);
setError(null);
engineRef.current.pause();
engineRef.current.seek(0);
};

const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
event.preventDefault();
setIsDragging(true);
};

const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
event.preventDefault();
if (event.currentTarget === event.target) {
setIsDragging(false);
}
};

const handleDrop = (event: DragEvent<HTMLDivElement>) => {
event.preventDefault();
setIsDragging(false);

    const file = event.dataTransfer.files?.[0];
    if (!file) {
      return;
    }

    processFile(file);

};

const handleFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
const file = event.target.files?.[0];
if (!file) {
return;
}

    processFile(file);

};

return (
<div className="container">
<header>
<h1>Engine Editor</h1>
</header>

      <main>
        {!videoSrc ? (
          <div
            className={`drop-zone ${isDragging ? "dragging" : ""}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <h2>Drag &amp; Drop your video here</h2>
            <p>or click to browse</p>
            {error && <div className="error">{error}</div>}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileInput}
              accept="video/*"
              className="file-input-hidden"
            />
          </div>
        ) : (
          <div className="player">
            <div className="video-canvas-container">
              <div className="canvas-wrapper">
                <canvas ref={previewCanvasRef} className="render-canvas" />
                <div className="custom-controls">
                  <button className="play-pause-btn" onClick={handlePlayPause}>
                    {isPlaying ? (
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                      </svg>
                    ) : (
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>
                  <div
                    className="playback-bar-container"
                    onClick={handleScrub}
                  >
                    <div
                      className="playback-bar-fill"
                      style={{ width: `${playbackProgress * 100}%` }}
                    />
                  </div>
                </div>
              </div>
              <video
                ref={videoRef}
                src={videoSrc}
                className="video-offscreen"
                onPlay={() => {
                  setIsPlaying(true);
                  engineRef.current.play(
                    mapSourceTimeToCompositionTimeMs(
                      (videoRef.current?.currentTime ?? 0) * 1000,
                      compositionConfig.cuts,
                    ) / 1000,
                  );
                }}
                onPause={() => {
                  setIsPlaying(false);
                  engineRef.current.pause();
                }}
                onEnded={() => {
                  setIsPlaying(false);
                  engineRef.current.pause();
                }}
                onTimeUpdate={(event) => {
                  const target = event.target as HTMLVideoElement;
                  const compositionDurationSeconds = getCompositionDurationSeconds(
                    target.duration,
                    compositionConfig.cuts,
                  );
                  if (
                    target.duration > 0 &&
                    compositionDurationSeconds !== null &&
                    compositionDurationSeconds > 0
                  ) {
                    const compositionTimeSeconds =
                      mapSourceTimeToCompositionTimeMs(
                        target.currentTime * 1000,
                        compositionConfig.cuts,
                      ) / 1000;
                    setPlaybackProgress(
                      Math.max(
                        0,
                        Math.min(1, compositionTimeSeconds / compositionDurationSeconds),
                      ),
                    );
                  } else {
                    setPlaybackProgress(0);
                  }
                }}
              />
            </div>

            <div className="player-actions">
              <button
                onClick={handleExport}
                disabled={isConverting}
                className="export-btn"
              >
                {isConverting ? "Exporting..." : "Export Processed Video"}
              </button>
              <button onClick={handleClose}>Close Video</button>
            </div>

            <CompositionConfigJsonEditor
              draftJson={configDraftJson}
              onDraftChange={setConfigDraftJson}
              onApply={handleApplyConfigJson}
              onFormat={handleFormatConfigJson}
              onReset={handleResetConfigJson}
              onSaveJson={handleSaveConfigJson}
              statusMessage={configEditorStatus}
              errorMessage={configEditorError}
              disabled={isConverting}
            />

            {error && <div className="error">{error}</div>}

            {exportProgress !== null && (
              <div className="export-progress-section">
                <p>Exporting: {Math.round(exportProgress * 100)}%</p>
                <div className="progress-bar-container">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${exportProgress * 100}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>

);
}
