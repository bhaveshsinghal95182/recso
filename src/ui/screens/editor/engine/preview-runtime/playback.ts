import type { MutableRefObject, RefObject } from 'react';

import { usePlaybackStore } from '@/store/playback-store';

import type { CompositionEngine } from '../engine';
import { syncVideoTime } from './video-time';

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
    return;
  }

  const video = videoRef.current;
  const webcamVideo = webcamVideoRef.current;
  if (!video) {
    return;
  }

  // Keep editor preview/timeline in source-time; cuts are applied only during render/export.
  syncVideoTime(video, currentTimeMs);
  if (webcamVideo && webcamSrc) {
    syncVideoTime(webcamVideo, currentTimeMs, 0.1);
  }

  engineRef.current.seek(currentTimeMs / 1000);
  renderCurrentFrame();
}
