import type { MutableRefObject, RefObject } from 'react';

import { usePlaybackStore } from '@/store/playback-store';

import type { CompositionEngine } from '../engine';
import { syncVideoTime } from './video-time';

let pendingPausedSeekRenderController: AbortController | null = null;
let pendingPausedWebcamRefreshController: AbortController | null = null;

function clearPendingPausedSeekRender(): void {
  if (!pendingPausedSeekRenderController) {
    return;
  }

  pendingPausedSeekRenderController.abort();
  pendingPausedSeekRenderController = null;
}

function clearPendingPausedWebcamRefresh(): void {
  if (!pendingPausedWebcamRefreshController) {
    return;
  }

  pendingPausedWebcamRefreshController.abort();
  pendingPausedWebcamRefreshController = null;
}

function schedulePausedWebcamRefreshWhenReady(
  webcamVideo: HTMLVideoElement,
  renderCurrentFrame: () => void,
): void {
  clearPendingPausedWebcamRefresh();

  const controller = new AbortController();
  pendingPausedWebcamRefreshController = controller;
  const { signal } = controller;

  const tryRefresh = () => {
    if (signal.aborted) {
      return;
    }

    if (webcamVideo.readyState < 2 || webcamVideo.seeking) {
      return;
    }

    renderCurrentFrame();
    clearPendingPausedWebcamRefresh();
  };

  webcamVideo.addEventListener('seeked', tryRefresh, { signal });
  webcamVideo.addEventListener('canplay', tryRefresh, { signal });
  webcamVideo.addEventListener('loadeddata', tryRefresh, { signal });
}

function schedulePausedSeekRenderWhenReady(
  video: HTMLVideoElement,
  renderCurrentFrame: () => void,
): void {
  clearPendingPausedSeekRender();

  const controller = new AbortController();
  pendingPausedSeekRenderController = controller;
  const { signal } = controller;

  const tryRender = () => {
    if (signal.aborted) {
      return;
    }

    if (video.readyState < 2 || video.seeking) {
      return;
    }

    renderCurrentFrame();
    clearPendingPausedSeekRender();
  };

  video.addEventListener('seeked', tryRender, { signal });
  video.addEventListener('canplay', tryRender, { signal });
  video.addEventListener('loadeddata', tryRender, { signal });
}

export interface PreviewTransportRefs {
  videoRef: RefObject<HTMLVideoElement | null>;
  webcamVideoRef: RefObject<HTMLVideoElement | null>;
  engineRef: MutableRefObject<CompositionEngine>;
}

export interface SyncPreviewTransportOnPlayStateOptions extends PreviewTransportRefs {
  isPlaying: boolean;
  pausePlayback: () => void;
  webcamSrc: string;
}

export function syncPreviewTransportOnPlayState({
  isPlaying,
  pausePlayback,
  webcamSrc,
  videoRef,
  webcamVideoRef,
  engineRef,
}: SyncPreviewTransportOnPlayStateOptions): void {
  clearPendingPausedSeekRender();
  clearPendingPausedWebcamRefresh();

  const video = videoRef.current;
  const webcamVideo = webcamVideoRef.current;

  if (!video) {
    return;
  }

  if (isPlaying) {
    const startTimeMs = usePlaybackStore.getState().currentTime;

    engineRef.current.play(startTimeMs / 1000);
    void video.play().catch(() => {
      pausePlayback();
    });

    if (webcamVideo && webcamSrc) {
      // Align webcam once on play start, then let it play continuously to avoid seek flicker.
      syncVideoTime(webcamVideo, startTimeMs, 0);
      void webcamVideo.play().catch(() => {
        // Webcam stream is optional in preview.
      });
    }

    return;
  }

  video.pause();
  webcamVideo?.pause();
  engineRef.current.pause();
}

export interface SyncPausedPreviewPositionOptions extends PreviewTransportRefs {
  isPlaying: boolean;
  currentTimeMs: number;
  webcamSrc: string;
  renderCurrentFrame: () => void;
}

export function syncPausedPreviewPosition({
  isPlaying,
  currentTimeMs,
  webcamSrc,
  renderCurrentFrame,
  videoRef,
  webcamVideoRef,
  engineRef,
}: SyncPausedPreviewPositionOptions): void {
  if (isPlaying) {
    clearPendingPausedSeekRender();
    clearPendingPausedWebcamRefresh();
    return;
  }

  const video = videoRef.current;
  const webcamVideo = webcamVideoRef.current;
  if (!video) {
    clearPendingPausedSeekRender();
    clearPendingPausedWebcamRefresh();
    return;
  }

  // Keep editor preview/timeline in source-time; cuts are applied only during render/export.
  syncVideoTime(video, currentTimeMs, 0.04);
  let shouldRefreshWebcamLater = false;
  if (webcamVideo && webcamSrc) {
    syncVideoTime(webcamVideo, currentTimeMs, 0.1);
    shouldRefreshWebcamLater = webcamVideo.readyState < 2 || webcamVideo.seeking;
  }

  engineRef.current.seek(currentTimeMs / 1000);

  if (video.readyState < 2 || video.seeking) {
    schedulePausedSeekRenderWhenReady(video, renderCurrentFrame);
    if (webcamVideo && webcamSrc && shouldRefreshWebcamLater) {
      schedulePausedWebcamRefreshWhenReady(webcamVideo, renderCurrentFrame);
    } else {
      clearPendingPausedWebcamRefresh();
    }
    return;
  }

  clearPendingPausedSeekRender();

  renderCurrentFrame();

  if (webcamVideo && webcamSrc && shouldRefreshWebcamLater) {
    schedulePausedWebcamRefreshWhenReady(webcamVideo, renderCurrentFrame);
  } else {
    clearPendingPausedWebcamRefresh();
  }
}
