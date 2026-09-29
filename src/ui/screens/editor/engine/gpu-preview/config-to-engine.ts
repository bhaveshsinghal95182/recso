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

import type { EngineCutRegion, EngineWebcamZoomRegion, EngineZoomRegion } from '@/electron';
import type { Project } from '@/types';

import {
  computeVideoLayout,
  computeWebcamLayout,
  computeWebcamRegionLayout,
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
  ShadowLayer,
  WebcamOverlayShape,
} from '../types';
import type { CursorBitmapTable } from './raster';
import {
  backgroundColour,
  buildCursorBitmapTable,
  canvasBackgroundColour,
  parseCssColour,
  rasteriseBackground,
  rasteriseCanvasBackground,
  rasteriseCursor,
} from './raster';

type EnginePlayer = typeof window.electron.engine.player;

/** The pointer's height in canvas pixels at cursor size 1. */
export const CURSOR_BASE_SIZE_PX = 28;

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

/**
 * Legacy zoom keyframes as zoom regions.
 *
 * The engine has one zoom model and it is the region. Keyframes were what came
 * before, and they hold the same four things -- a span, a level, a focal point
 * and an ease -- so they convert rather than needing a second model kept
 * alongside the first for projects nobody has re-saved.
 *
 * Only when there are no regions. A project with both has been migrated, and
 * the regions are the migration.
 *
 * Times are in seconds and against the *source*, unlike regions, which are
 * authored in composition time -- so they map through the cuts on the way. The
 * engine's regions carry one ease duration where a keyframe has two, and the
 * longer of the pair is the honest choice: it is the one that would still be
 * easing.
 */
function legacyZoomRegions(
  config: CompositionConfig,
  cuts: CompositionCutRegion[],
): EngineZoomRegion[] {
  if (config.zoomRegions?.length || !config.zooms?.length) {
    return [];
  }

  return config.zooms.map((keyframe) => ({
    startMs: mapSourceTimeToCompositionTimeMs(keyframe.startTime * 1000, cuts),
    endMs: mapSourceTimeToCompositionTimeMs(keyframe.endTime * 1000, cuts),
    zoomLevel: keyframe.multiplier,
    focalX: keyframe.focalPoint.x,
    focalY: keyframe.focalPoint.y,
    easeDurationMs: Math.max(keyframe.easeIn ?? 0, keyframe.easeOut ?? 0) * 1000,
  }));
}

/**
 * Webcam zoom regions, each carrying the box the camera sits in while it holds.
 *
 * The layout is resolved here rather than in the engine on purpose. The anchor
 * grid, the margin and the aspect fit are one formula and it lives on this
 * side; a second copy in Rust is precisely how a camera ends up one size in the
 * preview and another in the export. So the engine is given two rectangles and
 * asked to ease between them, which is arithmetic it cannot get wrong.
 *
 * The target height matches `computeActiveWebcamHeightRatio`: the region's own
 * override when it has one, otherwise the base scaled by the region's zoom
 * level, clamped to the same bounds the size control uses.
 */
function toEngineWebcamZoomRegions(
  config: CompositionConfig,
  canvas: CanvasSize,
): EngineWebcamZoomRegion[] {
  const webcam = config.webcam;
  const regions = config.webcamZoomRegions;
  if (!webcam?.enabled || !regions?.length) {
    return [];
  }

  const baseHeightRatio = webcam.heightRatio;

  return regions.map((region) => {
    const explicit = Number.isFinite(region.webcamHeightRatio)
      ? (region.webcamHeightRatio as number)
      : undefined;
    const zoomLevel = Number.isFinite(region.zoomLevel) ? region.zoomLevel : 1;
    const target = Math.min(
      0.75,
      Math.max(0.08, explicit ?? baseHeightRatio * Math.max(0.1, zoomLevel)),
    );

    const box = computeWebcamRegionLayout(canvas.width, canvas.height, webcam, target);

    return {
      startMs: region.startMs,
      endMs: region.endMs,
      easeDurationMs: Math.max(0, region.easeDurationMs),
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      fullScreen: region.webcamFullScreen === true,
    };
  });
}

/**
 * The layer stack, bottom first, in the names the engine understands.
 *
 * `background` goes through untouched: the engine accepts and skips it, being
 * the canvas rather than a layer. An empty list means the default order.
 */
function toEngineLayerOrder(config: CompositionConfig): string[] {
  return (config.layerStates ?? []).map((layer) => layer.id);
}

/**
 * A shadow stack, as the engine takes it.
 *
 * A straight translation -- the engine draws the same silhouette from the same
 * four numbers the Canvas2D compositor uses, so there is nothing to resolve
 * here. Which layers are worth drawing is decided in the engine instead, next
 * to the code that would otherwise size a quad for an invisible one.
 *
 * An unparseable colour drops the layer rather than falling back to black. A
 * shadow is decoration, and inventing an opaque black one under the recording
 * is a worse answer than leaving it out.
 */
function toEngineShadows(
  shadows: ShadowLayer[] | undefined,
): NonNullable<Parameters<EnginePlayer['setWebcamLayout']>[0]['shadows']> {
  return (shadows ?? []).flatMap((shadow) => {
    const colour = parseCssColour(shadow.color);
    return colour
      ? [
          {
            offsetX: shadow.offsetX,
            offsetY: shadow.offsetY,
            blur: shadow.blur,
            colour,
          },
        ]
      : [];
  });
}

function toEngineCuts(cuts: CompositionCutRegion[] | undefined): EngineCutRegion[] {
  return (cuts ?? []).map((cut) => ({ startMs: cut.startMs, endMs: cut.endMs }));
}

/**
 * A composition in the engine's vocabulary, with no engine attached to it yet.
 *
 * Resolving and applying are split because there are two consumers now: the
 * player, which takes setters, and the exporter, which takes one options object
 * on its own thread. They must not each do their own translation -- an export
 * that lays the webcam out differently from the preview it was approved in is
 * the exact failure this file exists to prevent.
 *
 * Every field is the setter's own parameter type rather than a shape written
 * out again here. Re-declaring them would be one more pair of things that have
 * to agree, and the whole point of this file is to have exactly one.
 */
export interface ResolvedComposition {
  layout: Parameters<EnginePlayer['setLayout']>[0];
  background: Parameters<EnginePlayer['setBackground']>[0];
  crop: Parameters<EnginePlayer['setSourceCrop']>[0];
  /** A zero-size box is the off switch, and costs nothing to render. */
  webcam: Parameters<EnginePlayer['setWebcamLayout']>[0];
  /** Null when the recording has no pointer, or it is switched off. */
  cursor: {
    image: Parameters<EnginePlayer['setCursorImage']>[0];
    images: Parameters<EnginePlayer['setCursorImages']>[0];
    track: Parameters<EnginePlayer['setCursorTrack']>[0];
    sizePx: number;
    effects: Parameters<EnginePlayer['setCursorEffects']>[0];
  } | null;
  zoomRegions: EngineZoomRegion[];
  cuts: EngineCutRegion[];
  /** Bottom first. Empty means the engine's default order. */
  layerOrder: string[];
  /** Spans where the camera changes size, or takes the whole frame. */
  webcamZoomRegions: EngineWebcamZoomRegion[];
  /**
   * Spans where the camera is not drawn, in composition time.
   *
   * Already mapped by the caller. A cut that takes the screen as well is gone
   * from the timeline entirely and collapses to nothing, so what survives here
   * is only the stretches that keep playing without the camera in them.
   */
  webcamCuts: EngineCutRegion[];
}

/**
 * Resolve a composition into engine terms. No IPC, no engine.
 */
export async function resolveComposition(
  config: CompositionConfig,
  canvas: CanvasSize,
  project: Project | null,
): Promise<ResolvedComposition> {
  const cuts = config.cuts ?? [];

  // ---- the recording's place on the canvas ---------------------------------

  const box = computeVideoLayout(canvas.width, canvas.height, config);
  const layout = {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    cornerRadius: config.video.borderRadius,
    borderWidth: config.video.border.width,
    borderColour: parseCssColour(config.video.border.color) ?? undefined,
    shadows: toEngineShadows(config.video.shadows),
  };

  // ---- background ----------------------------------------------------------
  //
  // From the project rather than from `config.background`, because for an engine
  // consumer the canvas background is always the one the user picked in the
  // panel -- a colour, a CSS pattern or an image file. `config.background` is
  // the Canvas2D compositor's own description, which the preview leaves
  // disabled (a DOM layer draws it behind a transparent canvas) and the export
  // fills in as a flat colour, so reading it here is how patterns and image
  // backgrounds ended up missing from both the engine preview and the engine
  // export. It stays as the fallback for a caller with no project, such as the
  // dev harness.

  const background = project
    ? {
        colour: canvasBackgroundColour(project),
        image: (await rasteriseCanvasBackground(project, canvas.width, canvas.height)) ?? undefined,
      }
    : {
        colour: backgroundColour(config.background),
        image: rasteriseBackground(config.background, canvas.width, canvas.height) ?? undefined,
      };

  // ---- crop ----------------------------------------------------------------

  const crop = resolveSourceCrop(project?.cropConfig);

  // ---- webcam --------------------------------------------------------------

  const webcam = config.webcam?.enabled
    ? (() => {
        const camera = computeWebcamLayout(canvas.width, canvas.height, config.webcam!);
        return {
          x: camera.x,
          y: camera.y,
          width: camera.width,
          height: camera.height,
          shape: engineShape(config.webcam!.shape),
          cornerRadius: config.webcam!.borderRadius,
          opacity: config.webcam!.opacity,
          borderWidth: config.webcam!.border.width,
          borderColour: parseCssColour(config.webcam!.border.color) ?? undefined,
          shadows: toEngineShadows(config.webcam!.shadows),
        };
      })()
    : { x: 0, y: 0, width: 0, height: 0 };

  // ---- cursor --------------------------------------------------------------

  let resolvedCursor: ResolvedComposition['cursor'] = null;
  const cursor = config.cursor;
  if (cursor?.enabled && cursor.events.length > 0) {
    // The pointer's height in canvas pixels, which the engine scales every
    // sprite to: 28px at size 1, so the built-in arrow (whose sprite leaves
    // room for its shadow) and a captured system pointer (which leaves room
    // around its shape too) both come out about as tall as a real one.
    const sizePx = CURSOR_BASE_SIZE_PX * Math.max(0.2, cursor.size);

    // The default pointer, drawn for any sample the recorder captured no
    // bitmap for -- and for every sample at all, on a recording from before
    // the recorder captured them. Rasterised for the size it is shown at.
    const bitmap = await rasteriseCursor(cursor, sizePx);

    // Overrides resolve against composition time, the same clock the track is
    // built on and the same one the engine looks samples up at.
    const at = (event: CompositionCursorEvent) =>
      mapSourceTimeToCompositionTimeMs(event.timestampMs, cuts);

    const table = await buildCursorBitmapTable(cursor, at, sizePx);

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

    resolvedCursor = {
      image: bitmap,
      images: table.images,
      track: withOverrideBoundaries(samples, cursor, table).map(
        ({ event: _event, ...sample }) => sample,
      ),
      sizePx,
      // `showMotionBlur` is the switch the editor already has for "make fast
      // pointer movement look fast". The engine answers it with a smear rather
      // than the compositor's trail of ghosted copies -- same setting, different
      // and better-looking mechanism, so nothing in the UI has to change.
      effects: {
        clickScale: cursor.showClickAnimations ? Math.max(1, cursor.clickAnimationScale) : 1,
        clickDurationMs: cursor.showClickAnimations ? Math.max(0, cursor.clickDisplayDuration) : 0,
        smearStrength: cursor.showMotionBlur ? Math.max(0, cursor.motionBlurStrength) : 0,
      },
    };
  }

  return {
    layout,
    background,
    crop,
    webcam,
    cursor: resolvedCursor,
    zoomRegions: config.zoomRegions?.length
      ? toEngineZoomRegions(config.zoomRegions)
      : legacyZoomRegions(config, cuts),
    cuts: toEngineCuts(cuts),
    webcamCuts: toEngineCuts(config.webcamCuts),
    layerOrder: toEngineLayerOrder(config),
    webcamZoomRegions: toEngineWebcamZoomRegions(config, canvas),
  };
}

/**
 * Push a whole composition into the engine.
 *
 * Everything here re-renders the frames already queued rather than going back
 * to the decoder, so this is cheap enough to call from a slider drag.
 *
 * `applied` is what this returned last time for the same player, and exists for
 * the background: it is a canvas-sized RGBA buffer, eight megabytes at 1080p,
 * and structured-cloning that across the IPC boundary sixty times a second
 * while someone drags the padding slider is not something to do for a picture
 * that has not changed. Passing `null` -- which a freshly opened player must --
 * sends everything.
 *
 * Nothing else is skipped. The rest of the setters carry numbers, and comparing
 * them would cost more than sending them.
 */
export async function applyComposition(
  player: EnginePlayer,
  config: CompositionConfig,
  canvas: CanvasSize,
  project: Project | null,
  applied?: ResolvedComposition | null,
): Promise<ResolvedComposition> {
  const resolved = await resolveComposition(config, canvas, project);

  await player.setLayout(resolved.layout);
  if (!sameBackground(applied?.background, resolved.background)) {
    await player.setBackground(resolved.background);
  }
  await player.setSourceCrop(resolved.crop);
  await player.setWebcamLayout(resolved.webcam);

  if (resolved.cursor) {
    await player.setCursorImage(resolved.cursor.image);
    await player.setCursorImages(resolved.cursor.images);
    await player.setCursorTrack(resolved.cursor.track);
    await player.setCursorStyle(resolved.cursor.sizePx, 1);
    await player.setCursorEffects(resolved.cursor.effects);
  } else {
    await player.setCursorImage(null);
    await player.setCursorImages([]);
    await player.setCursorTrack([]);
  }

  await player.setZoomRegions(resolved.zoomRegions);
  await player.setCuts(resolved.cuts);
  await player.setWebcamCuts(resolved.webcamCuts);
  await player.setLayerOrder(resolved.layerOrder);
  await player.setWebcamZoomRegions(resolved.webcamZoomRegions);

  return resolved;
}

/**
 * Whether two resolved backgrounds are the same picture.
 *
 * The bitmap is compared by identity rather than by content, which is exact
 * here rather than approximate: the rasteriser hands back the same object for
 * the same background, so two different objects really are two different
 * pictures. Comparing eight megabytes of pixels to avoid sending eight
 * megabytes of pixels would defeat the point.
 */
function sameBackground(
  previous: ResolvedComposition['background'] | undefined,
  next: ResolvedComposition['background'],
): boolean {
  if (!previous || previous.image !== next.image) {
    return false;
  }

  const a = previous.colour;
  const b = next.colour;
  if (!a || !b) {
    return a === b;
  }
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}
