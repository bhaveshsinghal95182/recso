import { Crop, Maximize2, Minimize2, Pause, Play, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { usePlaybackStore } from '@/store/playback-store';
import { useProjectStore } from '@/store/project-store';
import { focusedZoomId, isEditingFocalPoint, useTimelineStore } from '@/store/timeline-store';

import { resolveProjectWebcamSourcePath } from './export-pipeline/source-paths';
import { useGpuPreview } from './gpu-preview/session';
import { unsupportedFeatures } from './gpu-preview/unsupported';
import { resolveOverlayVideoLayout, resolvePreviewDisplaySize } from './preview-runtime/display';
import { usePreviewViewportSize } from './preview-runtime/viewport';
import { CropDialog } from '../crop-dialog';
import { FocalPointOverlay } from '../focal-point-overlay';
import { VerticalTabs } from '../vertical-tabs';
import { WebcamResizeOverlay } from '../webcam-resize-overlay';
import { mapCompositionToSourceTimeMs, mapSourceTimeToCompositionTimeMs } from './functions';
import { useEnginePreviewConfigMapper } from './preview-config-mapper.ts';

/**
 * The canvas the main process pushes engine textures into.
 *
 * A selector rather than a ref because `importSharedTexture` is applied in the
 * main process, which can only address the element by name.
 */
const GPU_CANVAS_SELECTOR = '#gpu-preview-canvas';

export function EnginePreview() {
  const { project, mouseEvents, updateWebcamOverlay } = useProjectStore();
  const { zoomRegions, zoomRegionsBySource, cuts, focus, updateZoom } = useTimelineStore();
  const { isPlaying, currentTime, seekRequestId, play, pause, finish } = usePlaybackStore();
  const screenZoomRegions = zoomRegionsBySource.screen;
  const webcamZoomRegions = zoomRegionsBySource.webcam;

  const previewViewportRef = useRef<HTMLDivElement>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement>(null);
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const availableSize = usePreviewViewportSize(previewViewportRef);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isExportPreviewFullscreen, setIsExportPreviewFullscreen] = useState(false);
  /**
   * Which compositor is driving the preview.
   *
   * The engine now, by default. The `<video>` path asks Chromium to decode the
   * whole recording in the renderer, which is where a long 4K take stops being
   * viable -- the engine streams it through Media Foundation instead and never
   * holds more than a few frames.
   *
   * The toggle stays, because the engine is not at parity: `unsupportedFeatures`
   * names what a given project would lose, and being able to flip back and
   * compare is how you tell an engine bug from an editing mistake.
   */
  const [isCropDialogOpen, setIsCropDialogOpen] = useState(false);
  const {
    canvasSize,
    layout,
    webcamLayout,
    compositionConfig,
    videoSrc,
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
  const selectedZoomId = focusedZoomId(focus);
  const editingFocalPoint = isEditingFocalPoint(focus);
  const selectedZoom = useMemo(
    () => zoomRegions.find((region) => region.id === selectedZoomId) ?? null,
    [zoomRegions, selectedZoomId],
  );

  const previewDisplaySize = useMemo(
    () => resolvePreviewDisplaySize(availableSize, canvasSize),
    [availableSize.height, availableSize.width, canvasSize.height, canvasSize.width],
  );

  // The engine's playhead is in composition time, which is what the editor's
  // store holds while previewing an export and what the timeline shows.
  // Against the preference rather than what is driving, because the value feeds
  // the hook that produces the error the driving flag is derived from. Seeking a
  // player that failed to open costs nothing.
  const gpuSeekMs = currentTime;

  const gpu = useGpuPreview({
    enabled: true,
    canvasRef: gpuCanvasRef,
    canvasSelector: GPU_CANVAS_SELECTOR,
    project,
    config: compositionConfig,
    canvasSize,
    isPlaying,
    seekToMs: gpuSeekMs,
    seekRequestId,
    // Resolved, not read straight off the project: `sourcePath` is often unset
    // and the sidecar is found by naming convention beside the recording. The
    // export pipeline has always done this; reading the raw field meant the
    // engine preview silently opened with no camera at all.
    webcamPath: resolveProjectWebcamSourcePath(project),
  });

  /**
   * The engine drives the preview only if it actually opened.
   *
   * A recording it cannot decode, a machine with no bindings, a GPU that would
   * not give up a device -- none of those should leave the editor with a blank
   * canvas when there is a working compositor sitting right there. The banner
   * says what happened.
   */
  const useGpuEngine = !gpu.error;

  const gpuGaps = useMemo(
    () => (useGpuEngine ? unsupportedFeatures(compositionConfig) : []),
    [useGpuEngine, compositionConfig],
  );

  // While the engine drives the preview it owns the clock, so the playhead has
  // to follow it rather than the `<video>` element.
  useEffect(() => {
    if (!useGpuEngine || !isPlaying) {
      return;
    }

    // The engine stops its own clock once the decoder is done and the frame
    // queue has drained. Nothing else tells the transport that, so without this
    // the editor stayed in "playing" forever after the recording ended.
    //
    // Both halves matter: `playing` is false before the first tick lands too, and
    // `endOfStream` is what separates "finished" from "not started yet". It is
    // cleared on seek, so this cannot latch.
    if (gpu.endOfStream && !gpu.playing) {
      // Rewinds as well as stops, so skip the position sync below -- it would
      // only put the playhead back at the end we are leaving.
      finish();
      return;
    }

    // `seek` rather than a raw `setState`: the engine clamps its clock to the
    // duration the *decoder* reports, which can sit a frame past the length the
    // editor derived from the project. Writing that straight into the store put
    // `currentTime` above `duration`, and the timeline positions the playhead at
    // `currentTime / duration` with no clamp of its own -- so it walked off the
    // right-hand edge. Going through the action clamps both to the same number.
    usePlaybackStore.getState().seek(gpu.currentTimeMs);
  }, [useGpuEngine, isPlaying, gpu.currentTimeMs, gpu.endOfStream, gpu.playing, finish]);

  /**
   * Sound, while the engine draws the picture.
   *
   * The engine has no audio output -- it decodes and mixes for an export, but
   * playback is silent -- so making it the default preview took the editor's
   * sound away with it. This plays the recording's own audio track alongside.
   *
   * An `<audio>` element rather than the hidden `<video>` that is already here:
   * pointed at the same file it decodes only the audio, which matters when the
   * whole reason the engine drives the picture is that asking Chromium to
   * decode a long 4K recording is what stopped working.
   *
   * The engine's clock is in composition time and the file is in source time,
   * so every seek maps between them -- and a cut is just a large drift, caught
   * by the same correction that handles ordinary slippage.
   */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !useGpuEngine) {
      return;
    }

    if (!isPlaying) {
      audio.pause();
      return;
    }

    const sourceSeconds = mapCompositionToSourceTimeMs(gpu.currentTimeMs, screenCuts) / 1000;
    // A quarter of a second is past hearing it as anything but wrong, and well
    // clear of the jitter of two clocks reading each other.
    if (Math.abs(audio.currentTime - sourceSeconds) > 0.25) {
      audio.currentTime = sourceSeconds;
    }

    if (audio.paused) {
      void audio.play().catch(() => {
        // Autoplay refused, or the file has no audio track. Neither is worth
        // interrupting a silent preview over.
      });
    }
  }, [useGpuEngine, isPlaying, gpu.currentTimeMs, screenCuts]);

  const overlayVideoLayout = useMemo(
    () => resolveOverlayVideoLayout(layout, previewDisplaySize.scale),
    [layout.height, layout.width, layout.x, layout.y, previewDisplaySize.scale],
  );

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

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      pause();
      return;
    }

    play();
  }, [isPlaying, pause, play]);

  const handleWebcamResize = useCallback(
    (heightRatio: number) => {
      // Clearing the preset keeps the size pills in the webcam panel honest —
      // a hand-dragged size is no longer small/medium/large.
      void updateWebcamOverlay({ size: undefined, heightRatio });
    },
    [updateWebcamOverlay],
  );

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

  // const hasCrop =
  //   project.cropConfig &&
  //   (project.cropConfig.top > 0 ||
  //     project.cropConfig.left > 0 ||
  //     project.cropConfig.bottom > 0 ||
  //     project.cropConfig.right > 0);

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

          <canvas
            id="gpu-preview-canvas"
            ref={gpuCanvasRef}
            className={`absolute inset-0 w-full h-full ${useGpuEngine ? '' : 'hidden'}`}
          />

          {/* Audio only, for when the engine is drawing the picture. */}
          <audio ref={audioRef} src={videoSrc} preload="auto" />

          {!isExportPreviewFullscreen &&
            !editingFocalPoint &&
            webcamLayout &&
            project.webcamOverlay?.enabled && (
              <WebcamResizeOverlay
                webcamOverlay={project.webcamOverlay}
                webcamLayout={webcamLayout}
                canvasSize={canvasSize}
                previewScale={previewDisplaySize.scale}
                onResize={handleWebcamResize}
              />
            )}

          {editingFocalPoint && selectedZoom && project.videoDimensions && (
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

      <div className="bottom-toolbar absolute bottom-6 right-6 flex items-center text-white bg-black/60 backdrop-blur overflow-hidden">
        <button
          className="px-3 py-3 border-0 bg-emerald-500/80 hover:bg-emerald-500 cursor-default transition-colors flex items-center justify-center"
          title="Previewing through the native GPU engine"
          aria-label="Toggle the GPU engine preview"
          aria-pressed="true"
        >
          <Zap className="w-5 h-5" />
        </button>

        <button
          onClick={() => setIsCropDialogOpen(true)}
          className={`px-3 py-3 border-0 cursor-pointer hover:bg-black/70 transition-colors flex items-center justify-center`}
          title="Crop recording"
          aria-label="Crop recording"
        >
          <Crop className="w-5 h-5" />
        </button>

        <button
          onClick={handleFullscreenPreview}
          className="px-3 py-3 border-0 cursor-pointer hover:bg-black/70 transition-colors flex items-center justify-center"
          title={
            isExportPreviewFullscreen
              ? 'Exit fullscreen export preview'
              : 'Fullscreen export preview'
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
      </div>

      {(gpu.error || gpuGaps.length > 0) && (
        <div className="absolute top-6 left-6 max-w-sm rounded-lg bg-black/70 backdrop-blur px-4 py-3 text-white text-xs leading-relaxed">
          {gpu.error ? (
            <>
              <p className="font-semibold text-red-300">The GPU engine could not start</p>
              <p className="mt-1 opacity-80">{gpu.error}</p>
              <p className="mt-1 opacity-60">
                The native preview is unavailable until this issue is resolved.
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold">Not drawn by the engine yet</p>
              <ul className="mt-1 space-y-0.5 opacity-80">
                {gpuGaps.map((gap) => (
                  <li key={gap.label}>
                    <span className="font-medium">{gap.label}</span> — {gap.detail}
                    {/* Cosmetic gaps do not send an export back to the canvas
                        path, and saying so matters: the default webcam shadow
                        used to be one, and it read as "your export will be
                        wrong" on every recording with a camera. */}
                    {gap.severity === 'cosmetic' && (
                      <span className="opacity-60"> (export still uses the engine)</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {!isExportPreviewFullscreen && <VerticalTabs />}

      <CropDialog open={isCropDialogOpen} onOpenChange={setIsCropDialogOpen} />
    </div>
  );
}
