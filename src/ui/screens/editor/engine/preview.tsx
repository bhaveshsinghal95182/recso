import { Maximize2, Minimize2, Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import {
  defaultConfig,
  getCutAdjustedDurationMs,
  mapCompositionToSourceTimeMs,
  mapSourceCutRangesToCompositionCutRanges,
  mapSourceTimeToCompositionTimeMs,
} from './functions';
import { useEnginePreviewConfigMapper } from './preview-config-mapper.ts';
import type { CompositionConfig } from './types';

export function EnginePreview() {
  const { project, mouseEvents } = useProjectStore();
  const {
    zoomRegions,
    zoomRegionsBySource,
    cuts,
    isEditingFocalPoint,
    selectedZoomId,
    updateZoom,
  } = useTimelineStore();
  const { isPlaying, currentTime, play, pause, setDuration } = usePlaybackStore();
  const screenZoomRegions = zoomRegionsBySource.screen;
  const webcamZoomRegions = zoomRegionsBySource.webcam;

  const previewViewportRef = useRef<HTMLDivElement>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement>(null);
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
  const [isExportPreviewFullscreen, setIsExportPreviewFullscreen] = useState(false);
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
    shouldRenderBackground,
  } = useEnginePreviewConfigMapper(
    project,
    screenZoomRegions,
    cuts,
    mouseEvents,
    webcamZoomRegions,
  );
  const screenCuts = useMemo(() => cuts.filter((cut) => cut.targets?.screen ?? true), [cuts]);
  const webcamCuts = useMemo(() => cuts.filter((cut) => cut.targets?.webcam ?? true), [cuts]);
  const fullscreenDurationMs = useMemo(
    () => getCutAdjustedDurationMs(durationMs, screenCuts),
    [durationMs, screenCuts],
  );
  const playbackDurationMs = isExportPreviewFullscreen ? fullscreenDurationMs : durationMs;
  const playbackCompositionConfig = useMemo<CompositionConfig>(() => {
    if (!isExportPreviewFullscreen) {
      return compositionConfig;
    }

    return {
      ...compositionConfig,
      webcamCuts: mapSourceCutRangesToCompositionCutRanges(webcamCuts, screenCuts),
    };
  }, [compositionConfig, isExportPreviewFullscreen, screenCuts, webcamCuts]);

  const selectedZoom = useMemo(
    () => zoomRegions.find((region) => region.id === selectedZoomId) ?? null,
    [zoomRegions, selectedZoomId],
  );

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
    if (playbackDurationMs > 0) {
      setDuration(playbackDurationMs);
      engineRef.current.setDuration(playbackDurationMs / 1000);
    }
  }, [playbackDurationMs, setDuration]);

  useEffect(() => {
    compositionConfigRef.current = playbackCompositionConfig;
    engineRef.current.setComposition(playbackCompositionConfig);
    renderCurrentFrame();
  }, [playbackCompositionConfig, renderCurrentFrame]);

  useEffect(() => {
    syncPreviewTransportOnPlayState({
      isPlaying,
      pausePlayback: pause,
      webcamSrc,
      playbackMode: isExportPreviewFullscreen ? 'export' : 'source',
      cuts: screenCuts,
      videoRef,
      webcamVideoRef,
      engineRef,
    });
  }, [isPlaying, pause, webcamSrc, isExportPreviewFullscreen, screenCuts]);

  useEffect(() => {
    syncPausedPreviewPosition({
      isPlaying,
      currentTimeMs: currentTime,
      webcamSrc,
      renderCurrentFrame,
      playbackMode: isExportPreviewFullscreen ? 'export' : 'source',
      cuts: screenCuts,
      videoRef,
      webcamVideoRef,
      engineRef,
    });
  }, [
    currentTime,
    isPlaying,
    renderCurrentFrame,
    webcamSrc,
    isExportPreviewFullscreen,
    screenCuts,
  ]);

  useEffect(() => {
    return attachPreviewSession({
      project,
      videoSrc,
      webcamSrc,
      canvasSize,
      durationMs,
      playbackMode: isExportPreviewFullscreen ? 'export' : 'source',
      cuts: screenCuts,
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
    isExportPreviewFullscreen,
    project,
    renderCurrentFrame,
    screenCuts,
    videoSrc,
    webcamSrc,
  ]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isPreviewFullscreen = document.fullscreenElement === fullscreenContainerRef.current;
      setIsExportPreviewFullscreen((wasPreviewFullscreen) => {
        if (wasPreviewFullscreen === isPreviewFullscreen) {
          return wasPreviewFullscreen;
        }

        const playbackState = usePlaybackStore.getState();
        const nextTime = isPreviewFullscreen
          ? mapSourceTimeToCompositionTimeMs(playbackState.currentTime, screenCuts)
          : mapCompositionToSourceTimeMs(playbackState.currentTime, screenCuts);
        usePlaybackStore.setState({ currentTime: Math.max(0, nextTime) });
        return isPreviewFullscreen;
      });
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [screenCuts]);

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

  const handleFullscreenPreview = useCallback(() => {
    const fullscreenElement = fullscreenContainerRef.current;
    if (!fullscreenElement) {
      return;
    }

    if (document.fullscreenElement === fullscreenElement) {
      void document.exitFullscreen();
      return;
    }

    void fullscreenElement.requestFullscreen();
  }, []);

  if (!project) {
    return null;
  }

  return (
    <div
      ref={fullscreenContainerRef}
      className="relative w-full h-full flex items-center justify-center bg-background"
    >
      <div
        ref={previewViewportRef}
        className={`relative h-full w-full flex items-center justify-center ${
          isExportPreviewFullscreen ? 'p-0 bg-black' : 'p-4'
        }`}
      >
        <div
          className={`relative overflow-hidden ${
            isExportPreviewFullscreen ? 'rounded-none shadow-none' : 'rounded-lg shadow-2xl'
          }`}
          style={{
            width: `${previewDisplaySize.width}px`,
            height: `${previewDisplaySize.height}px`,
          }}
        >
          {shouldRenderBackground && (
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
          )}

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
        title={isPlaying ? 'Pause preview' : 'Play preview'}
      >
        {isPlaying ? (
          <Pause className="w-5 h-5 fill-white" />
        ) : (
          <Play className="w-5 h-5 fill-white" />
        )}
      </button>

      <button
        onClick={handleFullscreenPreview}
        className="absolute bottom-6 right-6 bg-black/60 backdrop-blur px-3 py-3 rounded-full text-white border-0 cursor-pointer hover:bg-black/70 transition-colors flex items-center justify-center"
        title={
          isExportPreviewFullscreen ? 'Exit fullscreen export preview' : 'Fullscreen export preview'
        }
        aria-label={
          isExportPreviewFullscreen
            ? 'Exit fullscreen export preview'
            : 'Open fullscreen export preview'
        }
      >
        {isExportPreviewFullscreen ? (
          <Minimize2 className="w-5 h-5" />
        ) : (
          <Maximize2 className="w-5 h-5" />
        )}
      </button>

      {!isExportPreviewFullscreen && <VerticalTabs />}
    </div>
  );
}
