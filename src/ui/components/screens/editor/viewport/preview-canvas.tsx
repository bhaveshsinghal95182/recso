/**
 * PreviewCanvas — Main video preview with cursor overlay.
 *
 * Features:
 * - Renders video frame on canvas
 * - Draws background (color or image)
 * - Overlays reconstructed cursor from frameState
 * - Playback controls (play/pause, seek)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useEditor } from '@/context/editor-context';

// Format milliseconds to MM:SS.ms
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor((ms % 1000) / 10);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${millis.toString().padStart(2, '0')}`;
}

export function PreviewCanvas() {
  const {
    project,
    isPlaying,
    currentTime,
    duration,
    frameState,
    play,
    pause,
    seek,
    updateDuration,
  } = useEditor();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoLoaded, setVideoLoaded] = useState(false);

  // Canvas dimensions (scaled for preview)
  const PREVIEW_WIDTH = 854;
  const PREVIEW_HEIGHT = 480;

  // Initialize video element
  useEffect(() => {
    if (!project?.rawVideoPath || !videoRef.current) return;

    const video = videoRef.current;
    // Normalize path for Windows (replace backslashes with forward slashes)
    const normalizedPath = project.rawVideoPath.replace(/\\/g, '/');
    const finalUrl = `file:///${normalizedPath}`;
    console.log('[PreviewCanvas] Loading video:', finalUrl);

    video.src = finalUrl;
    video.muted = true;

    const handleError = () => {
      console.error('Video load error:', video.error, video.src);
    };
    video.addEventListener('error', handleError);

    const handleLoadedMetadata = () => {
      console.log('[PreviewCanvas] Video metadata loaded. Duration:', video.duration);
      if (video.duration && !isNaN(video.duration)) {
        updateDuration(video.duration * 1000);
      }
      setVideoLoaded(true);
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
    };
  }, [project?.rawVideoPath]);

  // Sync video time with editor state
  useEffect(() => {
    if (!videoRef.current || !videoLoaded) return;

    const video = videoRef.current;
    const videoTime = currentTime / 1000;

    if (Math.abs(video.currentTime - videoTime) > 0.1) {
      video.currentTime = videoTime;
    }
  }, [currentTime, videoLoaded]);

  // Control video playback
  useEffect(() => {
    if (!videoRef.current || !videoLoaded) return;

    const video = videoRef.current;
    console.log('[PreviewCanvas] isPlaying changed:', isPlaying);

    if (isPlaying) {
      video.play().catch((e) => console.error('[PreviewCanvas] Play failed:', e));
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
      // Clear canvas
      ctx.fillStyle = project.backgroundColor || '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw video frame (centered and scaled)
      if (videoLoaded && video.readyState >= 2) {
        const videoAspect = video.videoWidth / video.videoHeight;
        const canvasAspect = canvas.width / canvas.height;

        let drawWidth: number;
        let drawHeight: number;

        // Fit video within canvas with padding
        const maxWidth = canvas.width * 0.9;
        const maxHeight = canvas.height * 0.9;

        if (videoAspect > canvasAspect) {
          drawWidth = maxWidth;
          drawHeight = drawWidth / videoAspect;
        } else {
          drawHeight = maxHeight;
          drawWidth = drawHeight * videoAspect;
        }

        const offsetX = (canvas.width - drawWidth) / 2;
        const offsetY = (canvas.height - drawHeight) / 2;

        // Draw video
        ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);

        // Draw cursor overlay
        if (frameState?.cursor && frameState.cursor.visible) {
          const cursor = frameState.cursor;

          // Scale cursor position to preview canvas
          const scaleX = drawWidth / project.videoDimensions.width;
          const scaleY = drawHeight / project.videoDimensions.height;
          const cursorX = offsetX + cursor.x * scaleX;
          const cursorY = offsetY + cursor.y * scaleY;

          // Draw cursor (simple circle for now)
          ctx.beginPath();
          ctx.arc(cursorX, cursorY, 8 * project.cursorConfig.size, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
          ctx.lineWidth = 2;
          ctx.stroke();

          // Draw click animation
          if (cursor.eventType === 'click' && project.cursorConfig.showClickAnimations) {
            ctx.beginPath();
            ctx.arc(
              cursorX,
              cursorY,
              20 * project.cursorConfig.clickAnimationScale,
              0,
              Math.PI * 2,
            );
            ctx.strokeStyle = 'rgba(99, 102, 241, 0.8)';
            ctx.lineWidth = 3;
            ctx.stroke();
          }
        }
      }

      requestAnimationFrame(render);
    };

    const animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [project, frameState, videoLoaded]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }, [isPlaying, play, pause]);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      seek(Number(e.target.value));
    },
    [seek],
  );

  if (!project) {
    return null;
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      {/* Hidden video element for frame source */}
      <video ref={videoRef} style={{ display: 'none' }} playsInline preload="auto" />

      {/* Visible canvas */}
      <canvas
        ref={canvasRef}
        className="max-w-full max-h-full bg-black shadow-2xl rounded-md"
        width={PREVIEW_WIDTH}
        height={PREVIEW_HEIGHT}
      />

      {/* Controls */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-3 items-center bg-black/70 backdrop-blur-md px-4 py-2 rounded-lg">
        <button
          onClick={handlePlayPause}
          title={isPlaying ? 'Pause' : 'Play'}
          className="bg-transparent border-0 text-white cursor-pointer p-2 rounded hover:bg-white/10 transition-colors"
        >
          {isPlaying ? '⏸' : '▶'}
        </button>

        <input
          type="range"
          min={0}
          max={duration}
          value={currentTime}
          onChange={handleSeek}
          style={{ width: 200 }}
          className="accent-primary h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
        />

        <span className="text-[13px] font-mono text-gray-300 min-w-[100px] text-center">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  );
}
