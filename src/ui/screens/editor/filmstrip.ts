/**
 * Reading a spritesheet back out onto a timeline lane.
 *
 * The engine writes one PNG per source, a grid of thumbnails at a fixed
 * interval. The lane draws a strip of them. These two things are not the same
 * spacing and never will be: the sheet's interval is fixed when the recording
 * is opened, while the lane's spacing depends on how wide the lane is right
 * now, which changes with the window and with the timeline's zoom.
 *
 * So there are two steps and they are kept apart. `filmstripCells` asks "given
 * a lane this wide, where do thumbnails go and what instant does each one
 * stand for?" — that is pure layout, and it knows nothing about spritesheets.
 * `frameRect` asks "which piece of this PNG shows that instant?" — that is
 * pure lookup, and it knows nothing about lanes.
 */

/** The part of a spritesheet's metadata needed to find a frame in it. */
export interface SheetGeometry {
  frameCount: number;
  intervalMs: number;
  frameWidth: number;
  frameHeight: number;
  columns: number;
}

/** A source rectangle inside the sheet image, for `drawImage`. */
export interface FrameRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Where one thumbnail goes on the lane, and what it shows. */
export interface FilmstripCell {
  xPx: number;
  widthPx: number;
  timeMs: number;
}

export interface FilmstripLayout {
  laneWidthPx: number;
  laneHeightPx: number;
  /** Width over height of one thumbnail in the sheet. */
  cellAspect: number;
  durationMs: number;
}

/**
 * How many thumbnails a lane may hold.
 *
 * A zoomed-in timeline can make a lane thousands of pixels wide, and every
 * cell is a `drawImage` on every repaint. Past this the strip is redundant
 * anyway — the thumbnails repeat, because the sheet has fewer frames than the
 * lane has room for.
 */
export const MAX_FILMSTRIP_CELLS = 400;

/**
 * Which piece of the sheet shows this instant.
 *
 * Clamps rather than returning null at either end. A lane is drawn edge to
 * edge, so a cell whose time lands a few milliseconds past the last frame
 * still has to show something — a gap there reads as a decode that failed
 * rather than as rounding.
 *
 * Returns null only when the geometry itself is unusable.
 */
export function frameRect(sheet: SheetGeometry, timeMs: number): FrameRect | null {
  const { frameCount, intervalMs, frameWidth, frameHeight, columns } = sheet;

  // A sheet with no frames, no columns to lay them in, or no interval between
  // them can't address a frame at all — there's nothing to clamp into.
  if (frameCount <= 0 || columns <= 0 || intervalMs <= 0) {
    return null;
  }

  // A nonsense instant is treated the same as "before the recording starts",
  // which the clamp below already resolves to frame 0.
  const safeTimeMs = Number.isFinite(timeMs) ? timeMs : 0;
  const rawIndex = Math.floor(safeTimeMs / intervalMs);
  const frameIndex = Math.min(Math.max(rawIndex, 0), frameCount - 1);

  const row = Math.floor(frameIndex / columns);
  const col = frameIndex % columns;

  return {
    sx: col * frameWidth,
    sy: row * frameHeight,
    sw: frameWidth,
    sh: frameHeight,
  };
}

/**
 * Lay a strip of thumbnails across a lane.
 *
 * Each cell is drawn at the lane's full height, so its width follows the
 * source's aspect ratio — a portrait webcam gets narrow cells and more of
 * them. A cell's time is the instant at its *left edge*, so reading the strip
 * left to right tracks the playhead moving left to right.
 *
 * The last cell usually overflows the lane's right edge; the lane clips it.
 * Stopping short instead would leave a bare stripe at the end of every lane.
 */
export function filmstripCells(layout: FilmstripLayout): FilmstripCell[] {
  const { laneWidthPx, laneHeightPx, cellAspect, durationMs } = layout;

  // A lane with no room, no height, or a source with no shape has no cells
  // to draw — `cellAspect > 0` also rejects NaN, which fails every comparison.
  if (laneWidthPx <= 0 || laneHeightPx <= 0 || !(cellAspect > 0)) {
    return [];
  }

  const naturalCellWidth = laneHeightPx * cellAspect;
  const naturalCount = Math.ceil(laneWidthPx / naturalCellWidth);

  // Past the cap the sheet has more lane than it has distinct frames for
  // anyway, so instead of stopping the strip short we widen the cells to
  // still reach the far edge.
  const count = Math.min(naturalCount, MAX_FILMSTRIP_CELLS);
  const cellWidth = count < naturalCount ? laneWidthPx / count : naturalCellWidth;

  const cells: FilmstripCell[] = [];
  for (let index = 0; index < count; index += 1) {
    const xPx = index * cellWidth;
    cells.push({
      xPx,
      widthPx: cellWidth,
      timeMs: (xPx / laneWidthPx) * durationMs,
    });
  }

  return cells;
}
