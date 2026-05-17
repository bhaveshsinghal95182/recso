import type { MutableRefObject, RefObject } from 'react';

import { usePlaybackStore } from '@/store/playback-store';
import type { Project } from '@/types';

import {
  CanvasFrameContext,
  createHtmlVideoFrameSource,
  HtmlVideoCoverFrameSource,
} from '../adapters';
import type { CompositionEngine } from '../engine';
import { mapCompositionToSourceTimeMs } from '../functions';
import type { CanvasSize } from '../preview-config/types';
import type { CompositionConfig, CompositionCutRegion } from '../types';
import { renderEngineFrameSafely } from './rendering';
import { getClampedVideoTime, syncVideoTime } from './video-time';

interface PreviewSessionRefs {
  previewCanvasRef: RefObject<HTMLCanvasElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  webcamVideoRef: RefObject<HTMLVideoElement | null>;
  previewContextRef: MutableRefObject<CanvasFrameContext | null>;
  rafRef: MutableRefObject<number | null>;
  lastRenderMsRef: MutableRefObject<number>;
  previewErrorLoggedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<CompositionEngine>;
  compositionConfigRef: MutableRefObject<CompositionConfig>;
}

export interface AttachPreviewSessionOptions extends PreviewSessionRefs {
  project: Project | null;
  videoSrc: string;
  webcamSrc: string;
  canvasSize: CanvasSize;
  durationMs: number;
  renderCurrentFrame: () => void;
  playbackMode: 'source' | 'export';
  cuts?: CompositionCutRegion[];
}

function stopLoop(rafRef: MutableRefObject<number | null>): void {
  if (rafRef.current !== null) {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }
}

function syncPlaybackVideoTime(
  video: HTMLVideoElement,
  targetMs: number,
  toleranceSeconds: number,
): boolean {
  if (video.seeking) {
    return false;
  }

  if (video.readyState < 2) {
    return false;
  }

  const nextSeconds = getClampedVideoTime(video, targetMs / 1000);
  if (Math.abs(video.currentTime - nextSeconds) > toleranceSeconds) {
    video.currentTime = nextSeconds;
    return false;
  }

  return true;
}

function playPreviewVideo(video: HTMLVideoElement, pausePlayback: () => void): void {
  if (!video.paused) {
    return;
  }

  void video.play().catch(() => {
    pausePlayback();
  });
}

function renderLoopFrame(
  now: number,
  options: AttachPreviewSessionOptions,
  cancelledRef: MutableRefObject<boolean>,
): void {
  if (cancelledRef.current) {
    return;
  }

  const {
    previewContextRef,
    videoRef,
    webcamVideoRef,
    rafRef,
    lastRenderMsRef,
    engineRef,
    previewErrorLoggedRef,
    playbackMode,
    cuts,
  } = options;

  const previewContext = previewContextRef.current;
  const sourceVideo = videoRef.current;
  const playbackState = usePlaybackStore.getState();

  if (!playbackState.isPlaying) {
    rafRef.current = requestAnimationFrame((nextNow) =>
      renderLoopFrame(nextNow, options, cancelledRef),
    );
    return;
  }

  // Cap preview rendering to 30fps to reduce CPU/GPU pressure in editor mode.
  if (now - lastRenderMsRef.current < 1000 / 30) {
    rafRef.current = requestAnimationFrame((nextNow) =>
      renderLoopFrame(nextNow, options, cancelledRef),
    );
    return;
  }

  lastRenderMsRef.current = now;

  if (previewContext && sourceVideo) {
    try {
      const engineTime = engineRef.current.tick(now);
      const targetCompositionMs = engineTime * 1000;
      const targetSourceMs =
        playbackMode === 'export'
          ? mapCompositionToSourceTimeMs(targetCompositionMs, cuts)
          : targetCompositionMs;

      // Keep video and engine close, but avoid excessive seek churn.
      const sourceVideoReady = syncPlaybackVideoTime(sourceVideo, targetSourceMs, 0.1);
      if (webcamVideoRef.current && options.webcamSrc) {
        syncPlaybackVideoTime(webcamVideoRef.current, targetSourceMs, 0.1);
      }

      const compositionMs =
        playbackMode === 'export' ? targetCompositionMs : sourceVideo.currentTime * 1000;

      if (playbackMode === 'source') {
        engineRef.current.seek(compositionMs / 1000);
      }

      playbackState.tick(compositionMs, 'absolute');

      if (playbackMode === 'export' && !sourceVideoReady) {
        sourceVideo.pause();
        webcamVideoRef.current?.pause();
        engineRef.current.play(compositionMs / 1000);
        rafRef.current = requestAnimationFrame((nextNow) =>
          renderLoopFrame(nextNow, options, cancelledRef),
        );
        return;
      }

      if (playbackMode === 'export') {
        playPreviewVideo(sourceVideo, () => usePlaybackStore.getState().pause());
        if (webcamVideoRef.current && options.webcamSrc) {
          playPreviewVideo(webcamVideoRef.current, () => {
            // Webcam is optional; keep the main preview running if it cannot resume.
          });
        }
      }

      const rendered = renderEngineFrameSafely({
        previewContext,
        engine: engineRef.current,
        previewErrorLoggedRef,
        errorScope: 'render loop',
      });
      if (!rendered) {
        usePlaybackStore.getState().pause();
        return;
      }
    } catch (error) {
      if (!previewErrorLoggedRef.current) {
        previewErrorLoggedRef.current = true;
        console.error('[EnginePreview] render loop failed:', error);
      }

      usePlaybackStore.getState().pause();
      return;
    }
  }

  rafRef.current = requestAnimationFrame((nextNow) =>
    renderLoopFrame(nextNow, options, cancelledRef),
  );
}

export function attachPreviewSession(options: AttachPreviewSessionOptions): () => void {
  const {
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
    engineRef,
    compositionConfigRef,
    renderCurrentFrame,
    playbackMode,
    cuts,
  } = options;

  if (!project || !videoSrc) {
    return () => {};
  }

  const previewCanvas = previewCanvasRef.current;
  const video = videoRef.current;
  if (!previewCanvas || !video) {
    return () => {};
  }

  const cancelledRef: MutableRefObject<boolean> = { current: false };
  const initializedRef: MutableRefObject<boolean> = { current: false };
  const initializingRef: MutableRefObject<boolean> = { current: false };

  const initializePreview = async (): Promise<void> => {
    if (cancelledRef.current) {
      return;
    }

    if (initializedRef.current) {
      return;
    }

    if (initializingRef.current) {
      return;
    }

    try {
      if (video.readyState < 1) {
        return;
      }

      initializingRef.current = true;

      previewCanvas.width = canvasSize.width;
      previewCanvas.height = canvasSize.height;

      // Render directly to the visible preview canvas to avoid WebGL/Pixi runtime failures.
      previewContextRef.current = new CanvasFrameContext(previewCanvas);

      engineRef.current.setComposition(compositionConfigRef.current);
      engineRef.current.setDuration(
        Math.max(0, (usePlaybackStore.getState().duration || durationMs) / 1000),
      );
      engineRef.current.setVideoSource(createHtmlVideoFrameSource(video, project.cropConfig));

      const webcamVideo = webcamVideoRef.current;
      if (webcamVideo && webcamSrc) {
        engineRef.current.setWebcamSource(new HtmlVideoCoverFrameSource(webcamVideo));
      } else {
        engineRef.current.setWebcamSource(null);
      }

      const compositionMs = usePlaybackStore.getState().currentTime;
      const sourceTimeMs =
        playbackMode === 'export'
          ? mapCompositionToSourceTimeMs(compositionMs, cuts)
          : compositionMs;
      syncVideoTime(video, sourceTimeMs, 0.04);
      if (webcamVideo && webcamSrc) {
        syncVideoTime(webcamVideo, sourceTimeMs, 0.04);
      }

      engineRef.current.seek(compositionMs / 1000);
      initializedRef.current = true;
      renderCurrentFrame();

      rafRef.current = requestAnimationFrame((now) => renderLoopFrame(now, options, cancelledRef));
    } catch (error) {
      if (!options.previewErrorLoggedRef.current) {
        options.previewErrorLoggedRef.current = true;
        console.error('[EnginePreview] initializePreview failed:', error);
      }
    } finally {
      initializingRef.current = false;
    }
  };

  const handleCanPlay = () => {
    if (initializedRef.current) {
      renderCurrentFrame();
      return;
    }

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
    cancelledRef.current = true;
    stopLoop(rafRef);

    video.removeEventListener('ended', handleEnded);
    video.removeEventListener('loadedmetadata', handleCanPlay);
    video.removeEventListener('canplay', handleCanPlay);

    video.pause();
    webcamVideoRef.current?.pause();
    engineRef.current.pause();
    engineRef.current.setVideoSource(null);
    engineRef.current.setWebcamSource(null);

    previewContextRef.current = null;
  };
}
