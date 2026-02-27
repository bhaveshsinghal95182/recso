import { Player, type PlayerRef } from '@remotion/player';
import { Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { usePlaybackStore } from '@/store/playback-store';
import { useProjectStore } from '@/store/project-store';
import { useTimelineStore } from '@/store/timeline-store';

import { MainComposition } from '../../../remotion/Composition';
import type { PrecomputedCursorFrame, RemotionInputProps } from '../../../remotion/types';
import { FocalPointOverlay } from './focal-point-overlay';
import { VerticalTabs } from './vertical-tabs';

const PREVIEW_FPS = 30;

/**
 * Preview component using @remotion/player.
 *
 * Renders the exact same MainComposition used for export,
 * giving a true WYSIWYG preview. The Player handles scaling
 * the composition to fit the container.
 */
export function MinimalPreview() {
  const { project } = useProjectStore();
  const { zoomRegions, isEditingFocalPoint, selectedZoomId, updateZoom } = useTimelineStore();
  const { isPlaying, currentTime, play, pause, tick, setDuration } = usePlaybackStore();

  const playerRef = useRef<PlayerRef>(null);

  // Cursor overlay state
  const [cursorFrames, setCursorFrames] = useState<PrecomputedCursorFrame[] | null>(null);
  const [cursorSizeMultiplier, setCursorSizeMultiplier] = useState(1.0);

  // Calculate composition dimensions from project
  const canvasWidth = 1920;
  const canvasHeight = 1080;

  // Calculate video layout — "fullscreen" approach: video fills the canvas
  // with letterboxing/pillarboxing to maintain aspect ratio
  const layout = useMemo(() => {
    if (!project?.videoDimensions) {
      return { x: 0, y: 0, width: canvasWidth, height: canvasHeight, scale: 1 };
    }

    const { width: videoW, height: videoH } = project.videoDimensions;
    const videoAspect = videoW / videoH;
    const canvasAspect = canvasWidth / canvasHeight;

    let drawWidth: number;
    let drawHeight: number;

    // Fit video within canvas maintaining aspect ratio (with 85% fill like old preview)
    const maxWidth = canvasWidth * 0.85;
    const maxHeight = canvasHeight * 0.85;

    if (videoAspect > canvasAspect) {
      drawWidth = maxWidth;
      drawHeight = drawWidth / videoAspect;
    } else {
      drawHeight = maxHeight;
      drawWidth = drawHeight * videoAspect;
    }

    const x = Math.round((canvasWidth - drawWidth) / 2);
    const y = Math.round((canvasHeight - drawHeight) / 2);

    return {
      x,
      y,
      width: Math.round(drawWidth),
      height: Math.round(drawHeight),
      scale: drawWidth / videoW,
    };
  }, [project?.videoDimensions, canvasWidth, canvasHeight]);

  // Duration in frames
  const durationMs = project?.timeline?.duration || 0;
  const durationInFrames = Math.max(1, Math.ceil((durationMs / 1000) * PREVIEW_FPS));

  // Update playback store duration when project loads
  useEffect(() => {
    if (durationMs > 0) {
      setDuration(durationMs);
    }
  }, [durationMs, setDuration]);

  // Fetch precomputed cursor data when project loads
  useEffect(() => {
    if (!project?.recordingId || durationInFrames <= 1) {
      setCursorFrames(null);
      return;
    }

    let cancelled = false;

    window.electron.editor
      .getPrecomputedCursor({
        fps: PREVIEW_FPS,
        totalFrames: durationInFrames,
        canvasWidth,
        canvasHeight,
        layout,
      })
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setCursorFrames(result.frames);
          setCursorSizeMultiplier(result.sizeMultiplier);
        } else {
          setCursorFrames(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[Preview] Failed to load cursor data:', err);
          setCursorFrames(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [project?.recordingId, durationInFrames, layout, canvasWidth, canvasHeight]);

  // Build input props for the composition
  const inputProps: RemotionInputProps = useMemo(() => {
    const videoPath = project?.rawVideoPath?.replace(/\\/g, '/') || '';
    const videoSrc = videoPath ? `file:///${videoPath}` : '';

    const props: RemotionInputProps = {
      videoSrc,
      backgroundColor: project?.backgroundColor || '#000000',
      backgroundPath: project?.backgroundPath,
      backgroundPattern: project?.backgroundPattern ?? undefined,
      layout,
      canvasWidth,
      canvasHeight,
      zoomRegions: zoomRegions.map((z) => ({
        id: z.id,
        startMs: z.startMs,
        endMs: z.endMs,
        zoomLevel: z.zoomLevel,
        focalX: z.focalX,
        focalY: z.focalY,
        easeDurationMs: z.easeDurationMs,
        focalKeyframes: z.focalKeyframes,
      })),
      // Cursor overlay data (Velocity recordings only)
      ...(cursorFrames && { cursorFrames, cursorSizeMultiplier }),
    };

    return props;
  }, [project, layout, canvasWidth, canvasHeight, zoomRegions, cursorFrames, cursorSizeMultiplier]);

  // Sync: Playback Store → Player (only when NOT playing, i.e. user scrubs timeline)
  // During playback, the Player is the source of truth — we don't seek from the store.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || isPlaying) return;

    const targetFrame = Math.round((currentTime / 1000) * PREVIEW_FPS);
    const currentPlayerFrame = player.getCurrentFrame();
    if (currentPlayerFrame !== null && Math.abs(currentPlayerFrame - targetFrame) > 1) {
      player.seekTo(targetFrame);
    }
  }, [currentTime, isPlaying]);

  // Sync: Play/Pause state → Player
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;

    if (isPlaying) {
      player.play();
    } else {
      player.pause();
    }
  }, [isPlaying]);

  // Sync: Player → Playback Store (frame updates during playback)
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;

    const handleFrameUpdate = (e: { detail: { frame: number } }) => {
      // Only sync from Player to store during playback
      if (!usePlaybackStore.getState().isPlaying) return;
      const timeMs = (e.detail.frame / PREVIEW_FPS) * 1000;
      tick(timeMs, 'absolute');
    };

    const handlePlay = () => {
      if (!usePlaybackStore.getState().isPlaying) {
        play();
      }
    };

    const handlePause = () => {
      if (usePlaybackStore.getState().isPlaying) {
        pause();
      }
    };

    const handleEnded = () => {
      pause();
    };

    player.addEventListener('frameupdate', handleFrameUpdate);
    player.addEventListener('play', handlePlay);
    player.addEventListener('pause', handlePause);
    player.addEventListener('ended', handleEnded);

    return () => {
      player.removeEventListener('frameupdate', handleFrameUpdate);
      player.removeEventListener('play', handlePlay);
      player.removeEventListener('pause', handlePause);
      player.removeEventListener('ended', handleEnded);
    };
  }, [tick, play, pause]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  if (!project) return null;

  return (
    <div className="relative w-full h-full flex items-center justify-center bg-background">
      <Player
        ref={playerRef}
        component={MainComposition}
        inputProps={inputProps}
        durationInFrames={durationInFrames}
        compositionWidth={canvasWidth}
        compositionHeight={canvasHeight}
        fps={PREVIEW_FPS}
        style={{
          width: '100%',
          maxHeight: '100%',
          aspectRatio: `${canvasWidth} / ${canvasHeight}`,
        }}
        className="rounded-lg shadow-2xl"
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
              // Explicitly clear smart-pan keyframes on manual edit
              updateZoom({ ...zoom, focalX, focalY, focalKeyframes: undefined });
            }
          }}
        />
      )}

      <VerticalTabs />
    </div>
  );
}
