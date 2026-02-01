import { Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useEditor } from '../../../context/editor-context';

export function MinimalPreview() {
  const { project, isPlaying, currentTime, duration, play, pause, seek, updateDuration } =
    useEditor();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoLoaded, setVideoLoaded] = useState(false);

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
      // Draw background
      ctx.fillStyle = project.backgroundColor || '#1a1a2e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

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

        ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
      }

      requestAnimationFrame(render);
    };

    const animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [project, videoLoaded]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => seek(Number(e.target.value)),
    [seek],
  );

  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${(s % 60).toString().padStart(2, '0')}`;
  };

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

      {/* Minimal controls */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-3 items-center bg-black/60 backdrop-blur px-4 py-2 rounded-full">
        <button
          onClick={handlePlayPause}
          className="text-white bg-transparent border-0 cursor-pointer p-1 hover:opacity-80 flex items-center justify-center"
        >
          {isPlaying ? (
            <Pause className="w-4 h-4 fill-white" />
          ) : (
            <Play className="w-4 h-4 fill-white" />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={duration}
          value={currentTime}
          onChange={handleSeek}
          className="w-48 accent-primary h-1 cursor-pointer"
        />
        <span className="text-xs text-gray-300 font-mono">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  );
}
