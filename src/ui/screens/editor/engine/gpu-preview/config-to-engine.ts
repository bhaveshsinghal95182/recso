/**
 * `CompositionConfig` -> engine calls.
 *
 * The editor describes a composition; the engine takes a pile of setters. This
 * is the translation, and it is the only place that knows both vocabularies.
 *
 * Two coordinate rules run through all of it, and they are the same rules the
 * Canvas2D compositor follows:
 *
 * - **Placement is resolved here.** The anchor grid, the padding fraction and
 *   the size ratios all become canvas pixels before the engine sees them, so
 *   there is one layout formula in the app rather than two that have to agree.
 * - **Cuts are in source time; everything else is in composition time.** Cursor
 *   events are recorded against the file and have to be mapped, which the
 *   export pipeline also does and the Canvas2D preview does not -- it seeks a
 *   `<video>` in source time instead. Skip the mapping and the pointer is fine
 *   until the first cut and wrong after it.
 */

import type { EngineCutRegion, EngineZoomRegion } from '@/electron';
import type { Project } from '@/types';

import {
  computeVideoLayout,
  computeWebcamLayout,
  isInCutRegion,
  mapSourceTimeToCompositionTimeMs,
} from '../functions';
import type { CanvasSize } from '../preview-config/types';
import { resolveSourceCrop } from '../source-crop';
import type {
  CompositionConfig,
  CompositionCursorConfig,
  CompositionCursorEvent,
  CompositionCutRegion,
  CompositionZoomRegion,
  WebcamOverlayShape,
} from '../types';
import type { CursorBitmapTable } from './raster';
import {
  backgroundColour,
  buildCursorBitmapTable,
  parseCssColour,
  rasteriseBackground,
  rasteriseCursor,
} from './raster';

type EnginePlayer = typeof window.electron.engine.player;

/** The engine's two overlay shapes, from the editor's four. */
function engineShape(shape: WebcamOverlayShape | undefined): 'rect' | 'ellipse' {
  // The three rectangle variants differ only in the aspect ratio the *layout*
  // uses, which is already resolved into the box by the time it gets here.
  return shape === 'circle' ? 'ellipse' : 'rect';
}

function toEngineZoomRegions(regions: CompositionZoomRegion[] | undefined): EngineZoomRegion[] {
  return (regions ?? []).map((region) => ({
    startMs: region.startMs,
    endMs: region.endMs,
    zoomLevel: region.zoomLevel,
    focalX: region.focalX,
    focalY: region.focalY,
    easeDurationMs: region.easeDurationMs,
    focalKeyframes: region.focalKeyframes?.map((point) => ({
      timestampMs: point.timestampMs,
      x: point.focalX,
      y: point.focalY,
    })),
  }));
}

/** A track sample, with the event it came from kept for override resolution. */
interface TrackSample {
  timestampMs: number;
  x: number;
  y: number;
  visible?: boolean;
  imageId?: number;
  click?: boolean;
  event: CompositionCursorEvent;
}

/**
 * Add a sample at each override boundary, so an override starts and ends on
 * time rather than on the next mouse event.
 *
 * This exists because the two paths resolve overrides against different things.
 * The compositor asks "what override covers the playhead?" every frame. The
 * engine holds the last sample until the next one, so an override can only take
 * effect where a sample exists -- and a stationary pointer produces no events
 * at all. Without this, an override that begins while the mouse is still would
 * not appear until the user moved it, which is exactly when someone would be
 * demonstrating the thing they added the override for.
 *
 * A boundary sample inherits the held position, since the pointer has not moved
 * -- only its shape changes. The closing one takes the id the underlying event
 * would have had anyway, which is the recorded bitmap, or another override if
 * one starts where this ends.
 *
 * It does *not* inherit the click, though. Copying a held sample that happened
 * to be a click would fire the pop again at the boundary, which is a click the
 * user never made -- and it would land at whatever arbitrary time an override
 * happens to start.
 */
function withOverrideBoundaries(
  samples: TrackSample[],
  cursor: CompositionCursorConfig,
  table: CursorBitmapTable,
): TrackSample[] {
  const overrides = cursor.cursorRegionOverrides;
  if (!overrides || overrides.length === 0 || samples.length === 0) {
    return samples;
  }

  const sorted = [...samples].sort((a, b) => a.timestampMs - b.timestampMs);

  /** The sample in effect at a time: the last one at or before it. */
  const heldAt = (timestampMs: number): TrackSample | undefined => {
    let held: TrackSample | undefined;
    for (const sample of sorted) {
      if (sample.timestampMs > timestampMs) {
        break;
      }
      held = sample;
    }
    return held;
  };

  const boundaries = overrides.flatMap((region) => [region.startMs, region.endMs]);
  const added: TrackSample[] = [];

  for (const boundary of boundaries) {
    const held = heldAt(boundary);
    // Nothing to inherit a position from: the override begins before the
    // pointer was ever recorded, so there is no cursor to reshape.
    if (!held || held.timestampMs === boundary) {
      continue;
    }

    added.push({
      ...held,
      timestampMs: boundary,
      imageId: table.idFor(held.event, boundary),
      click: false,
    });
  }

  return added.length === 0
    ? sorted
    : [...sorted, ...added].sort((a, b) => a.timestampMs - b.timestampMs);
}

function toEngineCuts(cuts: CompositionCutRegion[] | undefined): EngineCutRegion[] {
  return (cuts ?? []).map((cut) => ({ startMs: cut.startMs, endMs: cut.endMs }));
}

/**
 * Push a whole composition into the engine.
 *
 * Everything here re-renders the frames already queued rather than going back
 * to the decoder, so this is cheap enough to call from a slider drag.
 */
export async function applyComposition(
  player: EnginePlayer,
  config: CompositionConfig,
  canvas: CanvasSize,
  project: Project | null,
): Promise<void> {
  const cuts = config.cuts ?? [];

  // ---- the recording's place on the canvas ---------------------------------

  const layout = computeVideoLayout(canvas.width, canvas.height, config);
  const borderColour = parseCssColour(config.video.border.color) ?? undefined;

  await player.setLayout({
    x: layout.x,
    y: layout.y,
    width: layout.width,
    height: layout.height,
    cornerRadius: config.video.borderRadius,
    borderWidth: config.video.border.width,
    borderColour,
  });

  // ---- background ----------------------------------------------------------

  const image = rasteriseBackground(config.background, canvas.width, canvas.height);
  await player.setBackground({
    colour: backgroundColour(config.background),
    image: image ?? undefined,
  });

  // ---- crop ----------------------------------------------------------------

  const crop = resolveSourceCrop(project?.cropConfig);
  await player.setSourceCrop(crop);

  // ---- webcam --------------------------------------------------------------

  if (config.webcam?.enabled) {
    const box = computeWebcamLayout(canvas.width, canvas.height, config.webcam);
    await player.setWebcamLayout({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      shape: engineShape(config.webcam.shape),
      cornerRadius: config.webcam.borderRadius,
      opacity: config.webcam.opacity,
      borderWidth: config.webcam.border.width,
      borderColour: parseCssColour(config.webcam.border.color) ?? undefined,
    });
  } else {
    // A zero-size box is the off switch, and costs nothing to render.
    await player.setWebcamLayout({ x: 0, y: 0, width: 0, height: 0 });
  }

  // ---- cursor --------------------------------------------------------------

  const cursor = config.cursor;
  if (cursor?.enabled && cursor.events.length > 0) {
    // The default pointer, drawn for any sample the recorder captured no
    // bitmap for -- and for every sample at all, on a recording from before
    // the recorder captured them.
    const bitmap = await rasteriseCursor(cursor);
    await player.setCursorImage(bitmap);

    // Overrides resolve against composition time, the same clock the track is
    // built on and the same one the engine looks samples up at.
    const at = (event: CompositionCursorEvent) =>
      mapSourceTimeToCompositionTimeMs(event.timestampMs, cuts);

    const table = await buildCursorBitmapTable(cursor, at);
    await player.setCursorImages(table.images);

    const samples = cursor.events
      .filter((event) => Number.isFinite(event.timestampMs))
      // A pointer inside a cut belongs to a frame nobody will see.
      .filter((event) => !isInCutRegion(event.timestampMs, cuts))
      .map((event) => ({
        timestampMs: at(event),
        x: event.normalizedX ?? (cursor.sourceWidth > 0 ? event.x / cursor.sourceWidth : 0),
        y: event.normalizedY ?? (cursor.sourceHeight > 0 ? event.y / cursor.sourceHeight : 0),
        visible: event.visible,
        imageId: table.idFor(event, at(event)),
        click: event.eventType === 'click',
        event,
      }));

    await player.setCursorTrack(
      withOverrideBoundaries(samples, cursor, table).map(({ event: _event, ...sample }) => sample),
    );

    // The compositor's base size is 22px scaled by the user's multiplier; the
    // engine takes the resolved height in canvas pixels.
    await player.setCursorStyle(22 * Math.max(0.2, cursor.size), 1);

    // `showMotionBlur` is the switch the editor already has for "make fast
    // pointer movement look fast". The engine answers it with a smear rather
    // than the compositor's trail of ghosted copies -- same setting, different
    // and better-looking mechanism, so nothing in the UI has to change.
    await player.setCursorEffects({
      clickScale: cursor.showClickAnimations ? Math.max(1, cursor.clickAnimationScale) : 1,
      clickDurationMs: cursor.showClickAnimations ? Math.max(0, cursor.clickDisplayDuration) : 0,
      smearStrength: cursor.showMotionBlur ? Math.max(0, cursor.motionBlurStrength) : 0,
    });
  } else {
    await player.setCursorImage(null);
    await player.setCursorImages([]);
    await player.setCursorTrack([]);
  }

  // ---- timeline ------------------------------------------------------------

  await player.setZoomRegions(toEngineZoomRegions(config.zoomRegions));
  await player.setCuts(toEngineCuts(cuts));
}
