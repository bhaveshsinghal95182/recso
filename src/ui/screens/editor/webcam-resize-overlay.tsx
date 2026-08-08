/**
 * WebcamResizeOverlay
 *
 * The webcam is composited into the preview canvas, so it cannot be grabbed
 * directly. Its rect is deterministic though — `calculateFallbackWebcamLayout`
 * derives it from the overlay config — so this lays a DOM grip exactly on top of
 * the drawn pixels and writes `heightRatio` back as you drag.
 *
 * The anchor pins one edge per axis (or the midpoint, for a centred anchor), so
 * the grip sits on a corner that actually moves and the box grows away from
 * whatever is pinned.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import type { WebcamOverlayAnchor, WebcamOverlayConfig } from '@/types';

import { DEFAULT_WEBCAM_STYLE } from './engine/export-pipeline/defaults';
import { calculateFallbackWebcamLayout } from './engine/preview-config/layout';
import type { CanvasSize } from './engine/preview-config/types';
import type { CompositionLayout } from './engine/types';
import { resolveAnchorFractions } from './engine/webcam-anchor';

/** Matches MIN_SIZE_PERCENT / MAX_SIZE_PERCENT in the webcam panel. */
const MIN_HEIGHT_RATIO = 0.08;
const MAX_HEIGHT_RATIO = 0.75;
/** How often the drag pushes a resize through to the store while moving. */
const DRAG_COMMIT_INTERVAL_MS = 80;

interface WebcamResizeOverlayProps {
  webcamOverlay: WebcamOverlayConfig;
  /** Webcam rect in canvas coordinates. */
  webcamLayout: CompositionLayout;
  canvasSize: CanvasSize;
  /** Canvas-to-preview scale factor. */
  previewScale: number;
  onResize: (heightRatio: number) => void;
}

/**
 * The point on one axis that stays put while resizing: the pinned edge for an
 * edge anchor, or the box's midpoint for a centred one.
 */
function resolveAxisReference(fraction: number, start: number, size: number): number {
  if (fraction === 0) {
    return start;
  }

  if (fraction === 1) {
    return start + size;
  }

  return start + size / 2;
}

/**
 * Box size implied by the pointer. A centred axis grows in both directions at
 * once, so the pointer's distance from the midpoint is only half the size.
 */
function resolveAxisSize(fraction: number, pointer: number, reference: number): number {
  const distance = Math.abs(pointer - reference);
  return fraction === 0.5 ? distance * 2 : distance;
}

/**
 * The grip goes on an edge that actually moves — opposite the pinned edge, or
 * either side when the axis is centred.
 */
function getGripPresentation(anchor: WebcamOverlayAnchor): { position: string; cursor: string } {
  const fractions = resolveAnchorFractions(anchor);
  const onRight = fractions.x !== 1;
  const onBottom = fractions.y !== 1;

  const position = cn(onBottom ? '-bottom-2.5' : '-top-2.5', onRight ? '-right-2.5' : '-left-2.5');
  const cursor = onRight === onBottom ? 'nwse-resize' : 'nesw-resize';

  return { position, cursor };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function WebcamResizeOverlay({
  webcamOverlay,
  webcamLayout,
  canvasSize,
  previewScale,
  onResize,
}: WebcamResizeOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const lastCommitMsRef = useRef(0);
  const [draftHeightRatio, setDraftHeightRatio] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const anchor = webcamOverlay.anchor ?? DEFAULT_WEBCAM_STYLE.anchor;
  const aspectRatio =
    Number.isFinite(webcamOverlay.aspectRatio) && (webcamOverlay.aspectRatio as number) > 0
      ? (webcamOverlay.aspectRatio as number)
      : DEFAULT_WEBCAM_STYLE.aspectRatio;
  const committedHeightRatio =
    Number.isFinite(webcamOverlay.heightRatio) && (webcamOverlay.heightRatio as number) > 0
      ? (webcamOverlay.heightRatio as number)
      : DEFAULT_WEBCAM_STYLE.heightRatio;

  // Hold the draft until the store round-trip lands, otherwise the box snaps
  // back to the old size for a frame when the drag ends.
  useEffect(() => {
    if (draftHeightRatio === null) {
      return;
    }

    if (!isDragging && Math.abs(committedHeightRatio - draftHeightRatio) < 0.0005) {
      setDraftHeightRatio(null);
    }
  }, [committedHeightRatio, draftHeightRatio, isDragging]);

  // While dragging, predict the rect locally with the same math the layout
  // resolver uses so the outline tracks the pointer without waiting on IPC.
  const activeLayout =
    draftHeightRatio === null
      ? webcamLayout
      : calculateFallbackWebcamLayout(canvasSize.width, canvasSize.height, {
          ...webcamOverlay,
          heightRatio: draftHeightRatio,
        });

  const rect = {
    left: activeLayout.x * previewScale,
    top: activeLayout.y * previewScale,
    width: activeLayout.width * previewScale,
    height: activeLayout.height * previewScale,
  };

  const handleGripMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const overlayElement = overlayRef.current;
      if (!overlayElement || previewScale <= 0) {
        return;
      }

      const overlayRect = overlayElement.getBoundingClientRect();
      const fractions = resolveAnchorFractions(anchor);
      const referenceX = resolveAxisReference(fractions.x, rect.left, rect.width);
      const referenceY = resolveAxisReference(fractions.y, rect.top, rect.height);
      let latestHeightRatio = committedHeightRatio;

      setIsDragging(true);
      lastCommitMsRef.current = 0;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const pointerX = moveEvent.clientX - overlayRect.left;
        const pointerY = moveEvent.clientY - overlayRect.top;

        // Distance from the pinned reference drives the size; take whichever
        // axis the pointer pushed further so diagonal drags feel direct.
        const heightFromPointer = resolveAxisSize(fractions.y, pointerY, referenceY);
        const heightFromWidth = resolveAxisSize(fractions.x, pointerX, referenceX) / aspectRatio;
        const nextHeightPx = Math.max(heightFromPointer, heightFromWidth);

        latestHeightRatio = clamp(
          nextHeightPx / previewScale / Math.max(1, canvasSize.height),
          MIN_HEIGHT_RATIO,
          MAX_HEIGHT_RATIO,
        );

        setDraftHeightRatio(latestHeightRatio);

        const now = performance.now();
        if (now - lastCommitMsRef.current >= DRAG_COMMIT_INTERVAL_MS) {
          lastCommitMsRef.current = now;
          onResize(latestHeightRatio);
        }
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        onResize(latestHeightRatio);
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [anchor, aspectRatio, canvasSize.height, committedHeightRatio, onResize, previewScale, rect],
  );

  const grip = getGripPresentation(anchor);
  const displayedPercent = Math.round((draftHeightRatio ?? committedHeightRatio) * 100);

  return (
    <div ref={overlayRef} className="pointer-events-none absolute inset-0" style={{ zIndex: 11 }}>
      <div
        className={cn(
          'group pointer-events-auto absolute rounded-[6px] border transition-colors duration-150',
          isDragging
            ? 'border-[#5eead4]/80'
            : 'border-white/25 hover:border-[#5eead4]/60 hover:bg-white/[0.04]',
        )}
        style={rect}
      >
        <button
          type="button"
          className={cn(
            'absolute grid size-5 place-items-center rounded-full border border-white/25 bg-[rgba(12,14,14,0.9)] text-white/80 shadow-[0_2px_8px_rgba(0,0,0,0.45)] transition duration-150',
            'hover:border-[#5eead4]/60 hover:text-[#ccfbf1]',
            isDragging && 'border-[#5eead4]/70 bg-emerald-400/25 text-[#ccfbf1]',
            grip.position,
          )}
          style={{ cursor: grip.cursor }}
          onMouseDown={handleGripMouseDown}
          title="Drag to resize the webcam"
          aria-label="Resize webcam overlay"
        >
          {/* Diagonal resize arrows, oriented by the grip's corner */}
          <svg
            viewBox="0 0 24 24"
            className="size-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: grip.cursor === 'nesw-resize' ? 'scaleX(-1)' : undefined }}
            aria-hidden="true"
          >
            <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
          </svg>
        </button>

        {isDragging && (
          <span className="absolute -top-7 left-1/2 -translate-x-1/2 rounded-[8px] border border-white/12 bg-[rgba(12,14,14,0.92)] px-2 py-1 font-mono text-[11px] tabular-nums text-white/85">
            {displayedPercent}%
          </span>
        )}
      </div>
    </div>
  );
}
