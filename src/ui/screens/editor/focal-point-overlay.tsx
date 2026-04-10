import { useCallback, useEffect, useRef, useState } from 'react';

import type { ZoomRegion } from '@/types';

interface FocalPointOverlayProps {
  /** Video native dimensions */
  videoWidth: number;
  videoHeight: number;
  /** Container (canvas) dimensions */
  containerWidth: number;
  containerHeight: number;
  /** Optional explicit video layout on canvas */
  videoLayout?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Currently selected zoom region */
  selectedZoom: ZoomRegion;
  /** Callback when focal point changes */
  onUpdate: (focalX: number, focalY: number) => void;
}

/**
 * FocalPointOverlay
 *
 * Renders a draggable focal point indicator over the video preview.
 * The indicator shows the current viewport (zoomed area) and a center dot.
 */
export function FocalPointOverlay({
  videoWidth,
  videoHeight,
  containerWidth,
  containerHeight,
  videoLayout,
  selectedZoom,
  onUpdate,
}: FocalPointOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Calculate video draw area (matching MinimalPreview logic)
  const videoAspect = videoWidth / videoHeight;
  const containerAspect = containerWidth / containerHeight;

  let drawWidth: number;
  let drawHeight: number;
  let offsetX: number;
  let offsetY: number;

  if (videoLayout) {
    drawWidth = videoLayout.width;
    drawHeight = videoLayout.height;
    offsetX = videoLayout.x;
    offsetY = videoLayout.y;
  } else {
    const maxWidth = containerWidth * 0.85;
    const maxHeight = containerHeight * 0.85;

    if (videoAspect > containerAspect) {
      drawWidth = maxWidth;
      drawHeight = drawWidth / videoAspect;
    } else {
      drawHeight = maxHeight;
      drawWidth = drawHeight * videoAspect;
    }

    offsetX = (containerWidth - drawWidth) / 2;
    offsetY = (containerHeight - drawHeight) / 2;
  }

  // Viewport size based on zoom level
  const viewportWidth = drawWidth / selectedZoom.zoomLevel;
  const viewportHeight = drawHeight / selectedZoom.zoomLevel;

  // Focal point in container coordinates
  const focalContainerX = offsetX + drawWidth * selectedZoom.focalX;
  const focalContainerY = offsetY + drawHeight * selectedZoom.focalY;

  // Viewport box position (centered on focal point)
  const viewportLeft = focalContainerX - viewportWidth / 2;
  const viewportTop = focalContainerY - viewportHeight / 2;

  // Convert container coordinates to normalized (0-1) video coordinates
  const containerToNormalized = useCallback(
    (clientX: number, clientY: number): { focalX: number; focalY: number } => {
      if (!overlayRef.current) return { focalX: 0.5, focalY: 0.5 };

      const rect = overlayRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;

      // Clamp to video area
      const videoX = Math.max(offsetX, Math.min(x, offsetX + drawWidth));
      const videoY = Math.max(offsetY, Math.min(y, offsetY + drawHeight));

      // Normalize to 0-1
      const focalX = (videoX - offsetX) / drawWidth;
      const focalY = (videoY - offsetY) / drawHeight;

      return { focalX, focalY };
    },
    [offsetX, offsetY, drawWidth, drawHeight],
  );

  // Mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;
      const { focalX, focalY } = containerToNormalized(e.clientX, e.clientY);
      // Direct update - context handles logic (was debounced locally before)
      onUpdate(focalX, focalY);
    },
    [isDragging, containerToNormalized, onUpdate],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Attach global mouse listeners when dragging
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  return (
    <div ref={overlayRef} className="absolute inset-0 pointer-events-none" style={{ zIndex: 10 }}>
      {/* Viewport rectangle */}
      <div
        className="absolute border-2 border-red-500 bg-red-500/10 pointer-events-auto cursor-move"
        style={{
          left: viewportLeft,
          top: viewportTop,
          width: viewportWidth,
          height: viewportHeight,
        }}
        onMouseDown={handleMouseDown}
      >
        {/* Focal point dot */}
        <div
          className="absolute w-4 h-4 bg-red-500 rounded-full border-2 border-white shadow-lg"
          style={{
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
          }}
        />
      </div>
    </div>
  );
}
