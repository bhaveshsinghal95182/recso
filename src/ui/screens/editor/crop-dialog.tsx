/**
 * CropDialog — Modal dialog for interactively cropping the screen recording.
 *
 * Displays the video frame at the current playhead position and lets the user
 * drag crop handles to define a sub-region. Crop values are stored as normalised
 * 0–1 fractions (top, left, bottom, right) relative to the original video
 * dimensions.
 */

import { Check, Crop, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { usePlaybackStore } from '@/store/playback-store';
import { useProjectStore } from '@/store/project-store';
import type { CropConfig } from '@/types';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MIN_CROP_FRACTION = 0.05; // minimum 5 % of either dimension
const EDGE_HIT = 8; // px - grab zone along an edge

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

type Edge = 'top' | 'right' | 'bottom' | 'left';
type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type DragTarget = Edge | Corner | 'move' | null;

function cursorForTarget(target: DragTarget): string {
  switch (target) {
    case 'top':
    case 'bottom':
      return 'ns-resize';
    case 'left':
    case 'right':
      return 'ew-resize';
    case 'top-left':
    case 'bottom-right':
      return 'nwse-resize';
    case 'top-right':
    case 'bottom-left':
      return 'nesw-resize';
    case 'move':
      return 'move';
    default:
      return 'default';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface CropDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CropDialog({ open, onOpenChange }: CropDialogProps) {
  const { project, updateCropConfig } = useProjectStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Local crop state (normalised 0–1): top, left, bottom, right insets.
  const [crop, setCrop] = useState<CropConfig>({ top: 0, left: 0, bottom: 0, right: 0 });
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const [dragStartCrop, setDragStartCrop] = useState<CropConfig | null>(null);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
  const [containerRect, setContainerRect] = useState<DOMRect | null>(null);
  const [videoNaturalSize, setVideoNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [videoReady, setVideoReady] = useState(false);

  // Sync crop from project on open
  useEffect(() => {
    if (open && project) {
      setCrop(project.cropConfig ?? { top: 0, left: 0, bottom: 0, right: 0 });
      setVideoReady(false);
    }
  }, [open, project]);

  // Video source
  const videoSrc = useMemo(() => {
    if (!project?.rawVideoPath) return '';
    return `file://${project.rawVideoPath.replace(/\\/g, '/')}`;
  }, [project?.rawVideoPath]);

  // Displayed area inside container (letterboxed)
  const displayRect = useMemo(() => {
    if (!containerRect || !videoNaturalSize) return null;
    const containerW = containerRect.width;
    const containerH = containerRect.height;
    const videoAspect = videoNaturalSize.w / videoNaturalSize.h;
    let w: number;
    let h: number;

    if (containerW / containerH > videoAspect) {
      h = containerH;
      w = h * videoAspect;
    } else {
      w = containerW;
      h = w / videoAspect;
    }

    return {
      x: (containerW - w) / 2,
      y: (containerH - h) / 2,
      w,
      h,
    };
  }, [containerRect, videoNaturalSize]);

  // Crop rect in display-pixel space
  const cropDisplayRect = useMemo(() => {
    if (!displayRect) return null;
    const x = displayRect.x + crop.left * displayRect.w;
    const y = displayRect.y + crop.top * displayRect.h;
    const w = displayRect.w * (1 - crop.left - crop.right);
    const h = displayRect.h * (1 - crop.top - crop.bottom);
    return { x, y, w, h };
  }, [crop, displayRect]);

  // Pixel dimensions after crop
  const croppedPixels = useMemo(() => {
    if (!project?.videoDimensions) return null;
    const w = Math.round(project.videoDimensions.width * (1 - crop.left - crop.right));
    const h = Math.round(project.videoDimensions.height * (1 - crop.top - crop.bottom));
    return { w, h };
  }, [crop, project?.videoDimensions]);

  const hasCrop = crop.top > 0 || crop.left > 0 || crop.bottom > 0 || crop.right > 0;

  // Measure container
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      if (containerRef.current) {
        setContainerRect(containerRef.current.getBoundingClientRect());
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [open]);

  // Read the current playhead time so we show that frame in the crop dialog
  const playheadTimeMs = usePlaybackStore((s) => s.currentTime);

  // Video load handler — seek to playhead position
  const handleVideoLoaded = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setVideoNaturalSize({ w: video.videoWidth, h: video.videoHeight });
    // Seek to the current playhead time (ms to seconds), clamped to video duration
    const targetSeconds = Math.max(0, Math.min(playheadTimeMs / 1000, video.duration || 0));
    video.currentTime = targetSeconds;
    setVideoReady(true);
  }, [playheadTimeMs]);

  // Hit-test: which drag target is under pointer?
  const hitTest = useCallback(
    (clientX: number, clientY: number): DragTarget => {
      if (!containerRect || !cropDisplayRect) return null;
      const px = clientX - containerRect.left;
      const py = clientY - containerRect.top;

      const { x, y, w, h } = cropDisplayRect;
      const inX = px >= x - EDGE_HIT && px <= x + w + EDGE_HIT;
      const inY = py >= y - EDGE_HIT && py <= y + h + EDGE_HIT;
      if (!inX || !inY) return null;

      const nearLeft = Math.abs(px - x) < EDGE_HIT;
      const nearRight = Math.abs(px - (x + w)) < EDGE_HIT;
      const nearTop = Math.abs(py - y) < EDGE_HIT;
      const nearBottom = Math.abs(py - (y + h)) < EDGE_HIT;

      if (nearTop && nearLeft) return 'top-left';
      if (nearTop && nearRight) return 'top-right';
      if (nearBottom && nearLeft) return 'bottom-left';
      if (nearBottom && nearRight) return 'bottom-right';
      if (nearTop) return 'top';
      if (nearBottom) return 'bottom';
      if (nearLeft) return 'left';
      if (nearRight) return 'right';

      // Inside the crop region — drag to move
      if (px >= x && px <= x + w && py >= y && py <= y + h) return 'move';
      return null;
    },
    [containerRect, cropDisplayRect],
  );

  // Mouse down
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const target = hitTest(e.clientX, e.clientY);
      if (!target) return;
      e.preventDefault();
      setDragTarget(target);
      setDragStartCrop({ ...crop });
      setDragStartPos({ x: e.clientX, y: e.clientY });
    },
    [crop, hitTest],
  );

  // Mouse move (document-level during drag)
  useEffect(() => {
    if (!dragTarget || !dragStartCrop || !dragStartPos || !displayRect) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - dragStartPos.x) / displayRect.w;
      const dy = (e.clientY - dragStartPos.y) / displayRect.h;

      setCrop(() => {
        let { top, left, bottom, right } = { ...dragStartCrop };

        switch (dragTarget) {
          case 'move': {
            const cropW = 1 - left - right;
            const cropH = 1 - top - bottom;
            let newLeft = left + dx;
            let newTop = top + dy;

            newLeft = clamp(newLeft, 0, 1 - cropW);
            newTop = clamp(newTop, 0, 1 - cropH);

            const dL = newLeft - left;
            const dT = newTop - top;

            return {
              top: top + dT,
              left: left + dL,
              bottom: bottom - dT,
              right: right - dL,
            };
          }
          case 'top':
            top = clamp(dragStartCrop.top + dy, 0, 1 - bottom - MIN_CROP_FRACTION);
            break;
          case 'bottom':
            bottom = clamp(dragStartCrop.bottom - dy, 0, 1 - top - MIN_CROP_FRACTION);
            break;
          case 'left':
            left = clamp(dragStartCrop.left + dx, 0, 1 - right - MIN_CROP_FRACTION);
            break;
          case 'right':
            right = clamp(dragStartCrop.right - dx, 0, 1 - left - MIN_CROP_FRACTION);
            break;
          case 'top-left':
            top = clamp(dragStartCrop.top + dy, 0, 1 - bottom - MIN_CROP_FRACTION);
            left = clamp(dragStartCrop.left + dx, 0, 1 - right - MIN_CROP_FRACTION);
            break;
          case 'top-right':
            top = clamp(dragStartCrop.top + dy, 0, 1 - bottom - MIN_CROP_FRACTION);
            right = clamp(dragStartCrop.right - dx, 0, 1 - left - MIN_CROP_FRACTION);
            break;
          case 'bottom-left':
            bottom = clamp(dragStartCrop.bottom - dy, 0, 1 - top - MIN_CROP_FRACTION);
            left = clamp(dragStartCrop.left + dx, 0, 1 - right - MIN_CROP_FRACTION);
            break;
          case 'bottom-right':
            bottom = clamp(dragStartCrop.bottom - dy, 0, 1 - top - MIN_CROP_FRACTION);
            right = clamp(dragStartCrop.right - dx, 0, 1 - left - MIN_CROP_FRACTION);
            break;
        }

        return { top, left, bottom, right };
      });
    };

    const handleMouseUp = () => {
      setDragTarget(null);
      setDragStartCrop(null);
      setDragStartPos(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragTarget, dragStartCrop, dragStartPos, displayRect]);

  // Cursor tracking for hover
  const [hoverTarget, setHoverTarget] = useState<DragTarget>(null);
  const handleMouseMoveHover = useCallback(
    (e: React.MouseEvent) => {
      if (dragTarget) return;
      setHoverTarget(hitTest(e.clientX, e.clientY));
    },
    [dragTarget, hitTest],
  );

  const handleApply = useCallback(() => {
    updateCropConfig(crop);
    onOpenChange(false);
  }, [crop, onOpenChange, updateCropConfig]);

  const handleReset = useCallback(() => {
    setCrop({ top: 0, left: 0, bottom: 0, right: 0 });
  }, []);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-[720px] max-w-[90vw] max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Crop className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Crop Recording</h2>
              <p className="text-[11px] text-muted-foreground">
                Drag the handles to define the crop area
              </p>
            </div>
          </div>
          <button
            onClick={handleCancel}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Crop canvas */}
        <div className="flex-1 min-h-0 p-5">
          <div
            ref={containerRef}
            className="relative w-full bg-black/90 rounded-xl overflow-hidden select-none"
            style={{
              aspectRatio: videoNaturalSize
                ? `${videoNaturalSize.w} / ${videoNaturalSize.h}`
                : '16 / 9',
              cursor: dragTarget ? cursorForTarget(dragTarget) : cursorForTarget(hoverTarget),
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMoveHover}
          >
            {/* Video thumbnail */}
            <video
              ref={videoRef}
              src={videoSrc}
              className="absolute inset-0 w-full h-full object-contain pointer-events-none"
              preload="auto"
              muted
              playsInline
              onLoadedData={handleVideoLoaded}
            />

            {/* Dim overlay outside crop */}
            {videoReady && displayRect && cropDisplayRect && (
              <>
                {/* Top bar */}
                <div
                  className="absolute bg-black/60 pointer-events-none"
                  style={{
                    left: `${displayRect.x}px`,
                    top: `${displayRect.y}px`,
                    width: `${displayRect.w}px`,
                    height: `${cropDisplayRect.y - displayRect.y}px`,
                  }}
                />
                {/* Bottom bar */}
                <div
                  className="absolute bg-black/60 pointer-events-none"
                  style={{
                    left: `${displayRect.x}px`,
                    top: `${cropDisplayRect.y + cropDisplayRect.h}px`,
                    width: `${displayRect.w}px`,
                    height: `${displayRect.y + displayRect.h - (cropDisplayRect.y + cropDisplayRect.h)}px`,
                  }}
                />
                {/* Left bar */}
                <div
                  className="absolute bg-black/60 pointer-events-none"
                  style={{
                    left: `${displayRect.x}px`,
                    top: `${cropDisplayRect.y}px`,
                    width: `${cropDisplayRect.x - displayRect.x}px`,
                    height: `${cropDisplayRect.h}px`,
                  }}
                />
                {/* Right bar */}
                <div
                  className="absolute bg-black/60 pointer-events-none"
                  style={{
                    left: `${cropDisplayRect.x + cropDisplayRect.w}px`,
                    top: `${cropDisplayRect.y}px`,
                    width: `${displayRect.x + displayRect.w - (cropDisplayRect.x + cropDisplayRect.w)}px`,
                    height: `${cropDisplayRect.h}px`,
                  }}
                />

                {/* Crop region border */}
                <div
                  className="absolute pointer-events-none border-2 border-primary/90"
                  style={{
                    left: `${cropDisplayRect.x}px`,
                    top: `${cropDisplayRect.y}px`,
                    width: `${cropDisplayRect.w}px`,
                    height: `${cropDisplayRect.h}px`,
                  }}
                >
                  {/* Rule-of-thirds grid */}
                  <div className="absolute inset-0">
                    <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/20" />
                    <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/20" />
                    <div className="absolute top-1/3 left-0 right-0 h-px bg-white/20" />
                    <div className="absolute top-2/3 left-0 right-0 h-px bg-white/20" />
                  </div>
                </div>

                {/* Corner handles */}
                {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as Corner[]).map(
                  (corner) => {
                    const isLeft = corner.includes('left');
                    const isTop = corner.includes('top');
                    return (
                      <div
                        key={corner}
                        className="absolute w-3 h-3 bg-primary border-2 border-white rounded-sm shadow-md pointer-events-none"
                        style={{
                          left: `${(isLeft ? cropDisplayRect.x : cropDisplayRect.x + cropDisplayRect.w) - 6}px`,
                          top: `${(isTop ? cropDisplayRect.y : cropDisplayRect.y + cropDisplayRect.h) - 6}px`,
                        }}
                      />
                    );
                  },
                )}

                {/* Edge midpoint handles */}
                {(['top', 'bottom', 'left', 'right'] as Edge[]).map((edge) => {
                  const isHorizontal = edge === 'top' || edge === 'bottom';
                  const cx = isHorizontal
                    ? cropDisplayRect.x + cropDisplayRect.w / 2
                    : edge === 'left'
                      ? cropDisplayRect.x
                      : cropDisplayRect.x + cropDisplayRect.w;
                  const cy = isHorizontal
                    ? edge === 'top'
                      ? cropDisplayRect.y
                      : cropDisplayRect.y + cropDisplayRect.h
                    : cropDisplayRect.y + cropDisplayRect.h / 2;

                  return (
                    <div
                      key={edge}
                      className="absolute bg-primary border-2 border-white rounded-sm shadow-md pointer-events-none"
                      style={{
                        left: `${cx - (isHorizontal ? 8 : 3)}px`,
                        top: `${cy - (isHorizontal ? 3 : 8)}px`,
                        width: `${isHorizontal ? 16 : 6}px`,
                        height: `${isHorizontal ? 6 : 16}px`,
                      }}
                    />
                  );
                })}
              </>
            )}

            {/* Loading state */}
            {!videoReady && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <div className="w-8 h-8 border-2 border-muted border-t-primary rounded-full animate-spin" />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3.5 border-t border-border bg-muted/20">
          {/* Dimensions info */}
          <div className="text-[11px] text-muted-foreground space-x-4">
            {croppedPixels && (
              <span>
                Output:{' '}
                <span className="font-mono text-foreground/80">
                  {croppedPixels.w} × {croppedPixels.h}
                </span>
              </span>
            )}
            {project?.videoDimensions && (
              <span>
                Original:{' '}
                <span className="font-mono text-foreground/50">
                  {project.videoDimensions.width} × {project.videoDimensions.height}
                </span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              disabled={!hasCrop}
              className="text-xs gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </Button>
            <Button variant="outline" size="sm" onClick={handleCancel} className="text-xs">
              Cancel
            </Button>
            <Button size="sm" onClick={handleApply} className="text-xs gap-1.5">
              <Check className="w-3.5 h-3.5" />
              Apply Crop
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
