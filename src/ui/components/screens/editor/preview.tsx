import { Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useEditor } from '../../../context/editor-context';
import type { ZoomRegion } from '../../../types';
import { FocalPointOverlay } from './focal-point-overlay';
import { VerticalTabs } from './vertical-tabs';

/**
 * Calculate the current zoom level based on time within a zoom region
 * Uses ease-in at the start and ease-out at the end
 */
function calculateZoomLevel(
  timeMs: number,
  region: ZoomRegion,
): { scale: number; focalX: number; focalY: number } {
  const regionDuration = region.endMs - region.startMs;
  const timeInRegion = timeMs - region.startMs;
  const easeDuration = Math.min(region.easeDurationMs, regionDuration / 2);

  let progress: number;

  if (timeInRegion < easeDuration) {
    // Ease in phase
    progress = timeInRegion / easeDuration;
    // Smooth easing using cosine
    progress = (1 - Math.cos(progress * Math.PI)) / 2;
  } else if (timeInRegion > regionDuration - easeDuration) {
    // Ease out phase
    const timeFromEnd = regionDuration - timeInRegion;
    progress = timeFromEnd / easeDuration;
    progress = (1 - Math.cos(progress * Math.PI)) / 2;
  } else {
    // Fully zoomed in
    progress = 1;
  }

  const scale = 1 + (region.zoomLevel - 1) * progress;
  return { scale, focalX: region.focalX, focalY: region.focalY };
}

export function MinimalPreview() {
  const {
    project,
    isPlaying,
    currentTime,
    play,
    pause,
    updateDuration,
    zoomRegions,
    isEditingFocalPoint,
    selectedZoomId,
    updateZoom,
  } = useEditor();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoLoaded, setVideoLoaded] = useState(false);

  // Refs to prevent flickering during scrubbing
  const seekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeekTimeRef = useRef<number>(0);

  // Initialize video element
  useEffect(() => {
    if (!project?.rawVideoPath || !videoRef.current) return;

    const video = videoRef.current;
    const normalizedPath = project.rawVideoPath.replace(/\\/g, '/');
    const finalUrl = `file:///${normalizedPath}`;
    video.src = finalUrl;
    video.muted = true;

    const handleLoadedMetadata = () => {
      if (video.duration && !isNaN(video.duration)) {
        updateDuration(video.duration * 1000);
      }
      setVideoLoaded(true);
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    return () => video.removeEventListener('loadedmetadata', handleLoadedMetadata);
  }, [project?.rawVideoPath, updateDuration]);

  // Sync video time with editor state - debounced to prevent flicker during scrubbing
  useEffect(() => {
    if (!videoRef.current || !videoLoaded) return;
    const video = videoRef.current;
    const videoTime = currentTime / 1000;

    // Skip if difference is minimal (prevents unnecessary seeks)
    if (Math.abs(video.currentTime - videoTime) <= 0.05) return;

    // During playback, sync immediately
    if (isPlaying) {
      if (Math.abs(video.currentTime - videoTime) > 0.15) {
        video.currentTime = videoTime;
      }
      return;
    }

    // During scrubbing (not playing), debounce the seek to prevent flicker
    if (seekTimeoutRef.current) {
      clearTimeout(seekTimeoutRef.current);
    }

    // Store target time for the canvas to use immediately
    lastSeekTimeRef.current = videoTime;

    // Debounce actual video seek to reduce flickering
    seekTimeoutRef.current = setTimeout(() => {
      if (
        videoRef.current &&
        Math.abs(videoRef.current.currentTime - lastSeekTimeRef.current) > 0.05
      ) {
        videoRef.current.currentTime = lastSeekTimeRef.current;
      }
    }, 50);

    return () => {
      if (seekTimeoutRef.current) {
        clearTimeout(seekTimeoutRef.current);
      }
    };
  }, [currentTime, videoLoaded, isPlaying]);

  // Control video playback
  useEffect(() => {
    if (!videoRef.current || !videoLoaded) return;
    const video = videoRef.current;
    if (isPlaying) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [isPlaying, videoLoaded]);

  // Render loop
  useEffect(() => {
    if (!canvasRef.current || !videoRef.current || !project) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const video = videoRef.current;

    const render = () => {
      // Draw background or clear if transparent
      if (project.backgroundColor === 'transparent') {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = project.backgroundColor || '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      // Draw video frame centered
      if (videoLoaded && video.readyState >= 2) {
        const videoAspect = video.videoWidth / video.videoHeight;
        const canvasAspect = canvas.width / canvas.height;

        let drawWidth: number;
        let drawHeight: number;
        const maxWidth = canvas.width * 0.85;
        const maxHeight = canvas.height * 0.85;

        if (videoAspect > canvasAspect) {
          drawWidth = maxWidth;
          drawHeight = drawWidth / videoAspect;
        } else {
          drawHeight = maxHeight;
          drawWidth = drawHeight * videoAspect;
        }

        const offsetX = (canvas.width - drawWidth) / 2;
        const offsetY = (canvas.height - drawHeight) / 2;

        // Check for active zoom region
        const activeZoom = zoomRegions.find(
          (z) => currentTime >= z.startMs && currentTime <= z.endMs,
        );

        if (activeZoom) {
          const { scale, focalX, focalY } = calculateZoomLevel(currentTime, activeZoom);

          // Calculate focal point in canvas coordinates (relative to video area)
          const focalCanvasX = offsetX + drawWidth * focalX;
          const focalCanvasY = offsetY + drawHeight * focalY;

          // Apply zoom transform around focal point
          ctx.save();
          ctx.translate(focalCanvasX, focalCanvasY);
          ctx.scale(scale, scale);
          ctx.translate(-focalCanvasX, -focalCanvasY);
          ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
          ctx.restore();
        } else {
          ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
        }
      }

      requestAnimationFrame(render);
    };

    const animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [project, videoLoaded, zoomRegions, currentTime]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  if (!project) return null;

  return (
    <div className="relative w-full h-full flex items-center justify-center bg-background">
      <video ref={videoRef} className="hidden" playsInline preload="auto" />

      <canvas
        ref={canvasRef}
        className="max-w-full max-h-full rounded-lg shadow-2xl"
        width={960}
        height={540}
      />

      {/* Play/Pause button overlay */}
      <button
        onClick={handlePlayPause}
        className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur px-4 py-3 rounded-full text-white border-0 cursor-pointer hover:bg-black/70 transition-colors flex items-center justify-center"
      >
        {isPlaying ? (
          <Pause className="w-5 h-5 fill-white" />
        ) : (
          <Play className="w-5 h-5 fill-white" />
        )}
      </button>

      {/* Focal Point Editor Overlay */}
      {isEditingFocalPoint && selectedZoomId && project.videoDimensions && (
        <FocalPointOverlay
          videoWidth={project.videoDimensions.width}
          videoHeight={project.videoDimensions.height}
          containerWidth={960}
          containerHeight={540}
          selectedZoom={zoomRegions.find((z) => z.id === selectedZoomId)!}
          onUpdate={(focalX, focalY) => {
            const zoom = zoomRegions.find((z) => z.id === selectedZoomId);
            if (zoom) {
              updateZoom({ ...zoom, focalX, focalY });
            }
          }}
        />
      )}

      <VerticalTabs />
    </div>
  );
}
