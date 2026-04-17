import type { MutableRefObject, RefObject } from 'react';

import { usePlaybackStore } from '@/store/playback-store';
import type { Project } from '@/types';

import { CanvasFrameContext, HtmlVideoCoverFrameSource, HtmlVideoFrameSource } from '../adapters';
import type { CompositionEngine } from '../engine';
import type { CanvasSize } from '../preview-config/types';
import type { CompositionConfig } from '../types';
import { renderEngineFrameSafely } from './rendering';
import { syncVideoTime } from './video-time';

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
}

function stopLoop(rafRef: MutableRefObject<number | null>): void {
  if (rafRef.current !== null) {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }
}

function renderLoopFrame(
  now: number,
  options: AttachPreviewSessionOptions,
  cancelledRef: MutableRefObject<boolean>,
): void {
  if (cancelledRef.current) {
    return;
  }

  const { previewContextRef, videoRef, rafRef, lastRenderMsRef, engineRef, previewErrorLoggedRef } =
    options;

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
      // In preview mode, use raw source time instead of cut-mapped composition time.
      const targetSourceMs = engineTime * 1000;

      // Keep video and engine close, but avoid excessive seek churn.
      syncVideoTime(sourceVideo, targetSourceMs, 0.1);

      const compositionMs = sourceVideo.currentTime * 1000;

      engineRef.current.seek(compositionMs / 1000);
      playbackState.tick(compositionMs, 'absolute');

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

  const initializePreview = async (): Promise<void> => {
    try {
      if (cancelledRef.current || video.readyState < 1) {
        return;
      }

      previewCanvas.width = canvasSize.width;
      previewCanvas.height = canvasSize.height;

      // Render directly to the visible preview canvas to avoid WebGL/Pixi runtime failures.
      previewContextRef.current = new CanvasFrameContext(previewCanvas);

      engineRef.current.setComposition(compositionConfigRef.current);
      engineRef.current.setDuration(
        Math.max(0, (usePlaybackStore.getState().duration || durationMs) / 1000),
      );
      engineRef.current.setVideoSource(new HtmlVideoFrameSource(video));

      const webcamVideo = webcamVideoRef.current;
      if (webcamVideo && webcamSrc) {
        engineRef.current.setWebcamSource(new HtmlVideoCoverFrameSource(webcamVideo));
      } else {
        engineRef.current.setWebcamSource(null);
      }

      const compositionMs = usePlaybackStore.getState().currentTime;
      syncVideoTime(video, compositionMs, 0);
      if (webcamVideo && webcamSrc) {
        syncVideoTime(webcamVideo, compositionMs, 0);
      }

      engineRef.current.seek(compositionMs / 1000);
      renderCurrentFrame();
      rafRef.current = requestAnimationFrame((now) => renderLoopFrame(now, options, cancelledRef));
    } catch (error) {
      if (!options.previewErrorLoggedRef.current) {
        options.previewErrorLoggedRef.current = true;
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
