import { Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { usePlaybackStore } from '@/store/playback-store';
import { useProjectStore } from '@/store/project-store';
import { useTimelineStore } from '@/store/timeline-store';

import { FocalPointOverlay } from '../focal-point-overlay';
import { VerticalTabs } from '../vertical-tabs';
import { CanvasFrameContext, HtmlVideoFrameSource } from './adapters';
import { CompositionEngine } from './engine';
import { defaultConfig } from './functions';
import { useEnginePreviewConfigMapper } from './preview-config-mapper';
import type { CompositionConfig } from './types';

function getClampedVideoTime(video: HTMLVideoElement, targetSeconds: number): number {
  const safeTarget = Number.isFinite(targetSeconds) ? Math.max(0, targetSeconds) : 0;
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    return safeTarget;
  }

  // Keep below exact duration to avoid triggering ended during seeks.
  return Math.min(safeTarget, Math.max(0, video.duration - 0.001));
}

function syncVideoTime(video: HTMLVideoElement, targetMs: number, toleranceSeconds = 0.04): void {
  const nextSeconds = getClampedVideoTime(video, targetMs / 1000);
  if (Math.abs(video.currentTime - nextSeconds) > toleranceSeconds) {
    video.currentTime = nextSeconds;
  }
}

export function EnginePreview() {
  const { project, mouseEvents } = useProjectStore();
  const { zoomRegions, cuts, isEditingFocalPoint, selectedZoomId, updateZoom } = useTimelineStore();
  const { isPlaying, currentTime, play, pause, setDuration } = usePlaybackStore();

  const previewViewportRef = useRef<HTMLDivElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewContextRef = useRef<CanvasFrameContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastRenderMsRef = useRef(0);
  const previewErrorLoggedRef = useRef(false);
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 });
  const engineRef = useRef<CompositionEngine>(new CompositionEngine(defaultConfig));
  const compositionConfigRef = useRef<CompositionConfig>(defaultConfig);
  const {
    canvasSize,
    layout,
    durationMs,
    compositionConfig,
    videoSrc,
    backgroundImageSrc,
    backgroundContainerStyle,
    selectedPattern,
    hasPattern,
  } = useEnginePreviewConfigMapper(project, zoomRegions, cuts, mouseEvents);

  const selectedZoom = useMemo(
    () => zoomRegions.find((region) => region.id === selectedZoomId) ?? null,
    [zoomRegions, selectedZoomId],
  );

  useEffect(() => {
    const viewport = previewViewportRef.current;
    if (!viewport) {
      return;
    }

    const updateSize = () => {
      setAvailableSize({
        width: Math.max(0, viewport.clientWidth),
        height: Math.max(0, viewport.clientHeight),
      });
    };

    updateSize();

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) {
        return;
      }

      setAvailableSize({
        width: Math.max(0, Math.round(entry.contentRect.width)),
        height: Math.max(0, Math.round(entry.contentRect.height)),
      });
    });

    observer.observe(viewport);

    return () => {
      observer.disconnect();
    };
  }, []);

  const previewDisplaySize = useMemo(() => {
    if (availableSize.width <= 0 || availableSize.height <= 0) {
      return {
        width: canvasSize.width,
        height: canvasSize.height,
        scale: 1,
      };
    }

    const scale = Math.min(
      availableSize.width / canvasSize.width,
      availableSize.height / canvasSize.height,
    );
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

    return {
      width: Math.max(1, Math.round(canvasSize.width * safeScale)),
      height: Math.max(1, Math.round(canvasSize.height * safeScale)),
      scale: safeScale,
    };
  }, [availableSize.height, availableSize.width, canvasSize.height, canvasSize.width]);

  const overlayVideoLayout = useMemo(
    () => ({
      x: layout.x * previewDisplaySize.scale,
      y: layout.y * previewDisplaySize.scale,
      width: layout.width * previewDisplaySize.scale,
      height: layout.height * previewDisplaySize.scale,
    }),
    [layout.height, layout.width, layout.x, layout.y, previewDisplaySize.scale],
  );

  const renderCurrentFrame = useCallback(() => {
    const previewContext = previewContextRef.current;
    if (!previewContext) {
      return;
    }

    try {
      const ctx = previewContext.get2DContext();
      ctx.clearRect(0, 0, previewContext.width, previewContext.height);
      engineRef.current.renderCurrentFrame(previewContext);
      previewErrorLoggedRef.current = false;
    } catch (error) {
      if (!previewErrorLoggedRef.current) {
        previewErrorLoggedRef.current = true;
        console.error('[EnginePreview] renderCurrentFrame failed:', error);
      }
    }
  }, []);

  useEffect(() => {
    if (durationMs > 0) {
      setDuration(durationMs);
      engineRef.current.setDuration(durationMs / 1000);
    }
  }, [durationMs, setDuration]);

  useEffect(() => {
    compositionConfigRef.current = compositionConfig;
    engineRef.current.setComposition(compositionConfig);
    renderCurrentFrame();
  }, [compositionConfig, renderCurrentFrame]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (isPlaying) {
      engineRef.current.play(currentTime / 1000);
      void video.play().catch(() => {
        pause();
      });
      return;
    }

    video.pause();
    engineRef.current.pause();
  }, [isPlaying, currentTime, pause]);

  useEffect(() => {
    if (isPlaying) {
      return;
    }

    const video = videoRef.current;
    if (!video) {
      return;
    }

    // Keep editor preview/timeline in source-time; cuts are applied only during render/export.
    syncVideoTime(video, currentTime);
    engineRef.current.seek(currentTime / 1000);
    renderCurrentFrame();
  }, [currentTime, isPlaying, renderCurrentFrame]);

  useEffect(() => {
    if (!project || !videoSrc) {
      return;
    }

    const previewCanvas = previewCanvasRef.current;
    const video = videoRef.current;
    if (!previewCanvas || !video) {
      return;
    }

    const engine = engineRef.current;
    let cancelled = false;

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
      const sourceVideo = videoRef.current;
      const playbackState = usePlaybackStore.getState();

      if (!playbackState.isPlaying) {
        rafRef.current = requestAnimationFrame(renderLoop);
        return;
      }

      // Cap preview rendering to 30fps to reduce CPU/GPU pressure in editor mode.
      if (now - lastRenderMsRef.current < 1000 / 30) {
        rafRef.current = requestAnimationFrame(renderLoop);
        return;
      }

      lastRenderMsRef.current = now;

      if (previewContext && sourceVideo) {
        try {
          const engineTime = engine.tick(now);
          // In preview mode, use raw source time instead of cut-mapped composition time.
          const targetSourceMs = engineTime * 1000;

          // Keep video and engine close, but avoid excessive seek churn.
          syncVideoTime(sourceVideo, targetSourceMs, 0.1);

          const compositionMs = sourceVideo.currentTime * 1000;

          engine.seek(compositionMs / 1000);
          playbackState.tick(compositionMs, 'absolute');

          const ctx = previewContext.get2DContext();
          ctx.clearRect(0, 0, previewContext.width, previewContext.height);
          engine.renderCurrentFrame(previewContext);
          previewErrorLoggedRef.current = false;
        } catch (error) {
          if (!previewErrorLoggedRef.current) {
            previewErrorLoggedRef.current = true;
            console.error('[EnginePreview] render loop failed:', error);
          }

          usePlaybackStore.getState().pause();
          return;
        }
      }

      rafRef.current = requestAnimationFrame(renderLoop);
    };

    const initializePreview = async () => {
      try {
        if (cancelled || video.readyState < 1) {
          return;
        }

        previewCanvas.width = canvasSize.width;
        previewCanvas.height = canvasSize.height;

        // Render directly to the visible preview canvas to avoid WebGL/Pixi runtime failures.
        previewContextRef.current = new CanvasFrameContext(previewCanvas);

        engine.setComposition(compositionConfigRef.current);
        engine.setDuration(
          Math.max(0, (usePlaybackStore.getState().duration || durationMs) / 1000),
        );
        engine.setVideoSource(new HtmlVideoFrameSource(video));

        const compositionMs = usePlaybackStore.getState().currentTime;
        const sourceMs = compositionMs;

        syncVideoTime(video, sourceMs, 0);
        engine.seek(compositionMs / 1000);
        renderCurrentFrame();
        rafRef.current = requestAnimationFrame(renderLoop);
      } catch (error) {
        if (!previewErrorLoggedRef.current) {
          previewErrorLoggedRef.current = true;
          console.error('[EnginePreview] initializePreview failed:', error);
        }
      }
    };

    const handleCanPlay = () => {
      void initializePreview();
    };

    const handleEnded = () => {
      usePlaybackStore.getState().pause();
    };

    video.addEventListener('ended', handleEnded);

    if (video.readyState >= 2) {
      void initializePreview();
    } else {
      video.addEventListener('loadedmetadata', handleCanPlay);
      video.addEventListener('canplay', handleCanPlay);
    }

    return () => {
      cancelled = true;
      stopLoop();

      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('loadedmetadata', handleCanPlay);
      video.removeEventListener('canplay', handleCanPlay);

      video.pause();
      engine.pause();
      engine.setVideoSource(null);

      previewContextRef.current = null;
    };
  }, [canvasSize.height, canvasSize.width, durationMs, project, renderCurrentFrame, videoSrc]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }

      engineRef.current.dispose();
    };
  }, []);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      pause();
      return;
    }

    play();
  }, [isPlaying, pause, play]);

  if (!project) {
    return null;
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center bg-background">
      <div
        ref={previewViewportRef}
        className="relative h-full w-full p-4 flex items-center justify-center"
      >
        <div
          className="relative rounded-lg shadow-2xl overflow-hidden"
          style={{
            width: `${previewDisplaySize.width}px`,
            height: `${previewDisplaySize.height}px`,
          }}
        >
          <div className="absolute inset-0" style={backgroundContainerStyle}>
            {backgroundImageSrc ? (
              <img
                src={backgroundImageSrc}
                alt="Preview background"
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : hasPattern && selectedPattern ? (
              <div className="absolute inset-0" style={selectedPattern.style} />
            ) : null}
          </div>

          <canvas ref={previewCanvasRef} className="absolute inset-0 w-full h-full" />

          <video ref={videoRef} src={videoSrc} className="hidden" playsInline preload="auto" />

          {isEditingFocalPoint && selectedZoomId && selectedZoom && project.videoDimensions && (
            <FocalPointOverlay
              videoWidth={project.videoDimensions.width}
              videoHeight={project.videoDimensions.height}
              containerWidth={previewDisplaySize.width}
              containerHeight={previewDisplaySize.height}
              videoLayout={overlayVideoLayout}
              selectedZoom={selectedZoom}
              onUpdate={(focalX, focalY) => {
                updateZoom({ ...selectedZoom, focalX, focalY, focalKeyframes: undefined });
              }}
            />
          )}
        </div>
      </div>

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

      <VerticalTabs />
    </div>
  );
}
