import { Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { usePlaybackStore } from '@/store/playback-store';
import { useProjectStore } from '@/store/project-store';
import { useTimelineStore } from '@/store/timeline-store';

import { resolveOverlayVideoLayout, resolvePreviewDisplaySize } from './preview-runtime/display';
import {
  syncPausedPreviewPosition,
  syncPreviewTransportOnPlayState,
} from './preview-runtime/playback';
import { renderEngineFrameSafely } from './preview-runtime/rendering';
import { attachPreviewSession } from './preview-runtime/session';
import { usePreviewViewportSize } from './preview-runtime/viewport';
import { FocalPointOverlay } from '../focal-point-overlay';
import { VerticalTabs } from '../vertical-tabs';
import { type CanvasFrameContext } from './adapters';
import { CompositionEngine } from './engine';
import { defaultConfig } from './functions';
import { useEnginePreviewConfigMapper } from './preview-config-mapper.ts';
import type { CompositionConfig } from './types';

export function EnginePreview() {
  const { project, mouseEvents, updateWebcamOverlay } = useProjectStore();
  const { zoomRegions, cuts, isEditingFocalPoint, selectedZoomId, updateZoom } = useTimelineStore();
  const { isPlaying, currentTime, play, pause, setDuration } = usePlaybackStore();

  const previewViewportRef = useRef<HTMLDivElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const previewContextRef = useRef<CanvasFrameContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastRenderMsRef = useRef(0);
  const previewErrorLoggedRef = useRef(false);
  const availableSize = usePreviewViewportSize(previewViewportRef);
  const engineRef = useRef<CompositionEngine>(new CompositionEngine(defaultConfig));
  const compositionConfigRef = useRef<CompositionConfig>(defaultConfig);
  const {
    canvasSize,
    layout,
    durationMs,
    compositionConfig,
    videoSrc,
    webcamSrc,
    backgroundImageSrc,
    backgroundContainerStyle,
    selectedPattern,
    hasPattern,
  } = useEnginePreviewConfigMapper(project, zoomRegions, cuts, mouseEvents);

  const selectedZoom = useMemo(
    () => zoomRegions.find((region) => region.id === selectedZoomId) ?? null,
    [zoomRegions, selectedZoomId],
  );

  const webcamSourcePath = project?.webcamOverlay?.sourcePath;
  const webcamToggleAvailable = Boolean(webcamSourcePath);
  const webcamEnabled = Boolean(project?.webcamOverlay?.enabled && webcamToggleAvailable);

  const previewDisplaySize = useMemo(
    () => resolvePreviewDisplaySize(availableSize, canvasSize),
    [availableSize.height, availableSize.width, canvasSize.height, canvasSize.width],
  );

  const overlayVideoLayout = useMemo(
    () => resolveOverlayVideoLayout(layout, previewDisplaySize.scale),
    [layout.height, layout.width, layout.x, layout.y, previewDisplaySize.scale],
  );

  const renderCurrentFrame = useCallback(() => {
    renderEngineFrameSafely({
      previewContext: previewContextRef.current,
      engine: engineRef.current,
      previewErrorLoggedRef,
      errorScope: 'renderCurrentFrame',
    });
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
    syncPreviewTransportOnPlayState({
      isPlaying,
      pausePlayback: pause,
      webcamSrc,
      videoRef,
      webcamVideoRef,
      engineRef,
    });
  }, [isPlaying, pause, webcamSrc]);

  useEffect(() => {
    syncPausedPreviewPosition({
      isPlaying,
      currentTimeMs: currentTime,
      webcamSrc,
      renderCurrentFrame,
      videoRef,
      webcamVideoRef,
      engineRef,
    });
  }, [currentTime, isPlaying, renderCurrentFrame, webcamSrc]);

  useEffect(() => {
    return attachPreviewSession({
      project,
      videoSrc,
      webcamSrc,
      canvasSize,
      durationMs,
      previewCanvasRef,
      videoRef,
      webcamVideoRef,
      previewContextRef,
      rafRef,
      lastRenderMsRef,
      previewErrorLoggedRef,
      engineRef,
      compositionConfigRef,
      renderCurrentFrame,
    });
  }, [
    canvasSize.height,
    canvasSize.width,
    durationMs,
    project,
    renderCurrentFrame,
    videoSrc,
    webcamSrc,
  ]);

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

  const handleToggleWebcam = useCallback(() => {
    if (!project || !webcamToggleAvailable) {
      return;
    }

    void updateWebcamOverlay({
      enabled: !webcamEnabled,
    });
  }, [project, webcamEnabled, webcamToggleAvailable, updateWebcamOverlay]);

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
          <video
            ref={webcamVideoRef}
            src={webcamSrc || undefined}
            className="hidden"
            playsInline
            preload="auto"
          />

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
