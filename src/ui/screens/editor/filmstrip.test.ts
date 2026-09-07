import { describe, expect, it } from 'vitest';

import {
  filmstripCells,
  type FilmstripLayout,
  frameRect,
  MAX_FILMSTRIP_CELLS,
  type SheetGeometry,
} from './filmstrip';

/** Sixty 160x90 thumbnails, ten to a row: a one-minute screen recording. */
function sheet(overrides: Partial<SheetGeometry> = {}): SheetGeometry {
  return {
    frameCount: 60,
    intervalMs: 1000,
    frameWidth: 160,
    frameHeight: 90,
    columns: 10,
    ...overrides,
  };
}

function layout(overrides: Partial<FilmstripLayout> = {}): FilmstripLayout {
  return {
    laneWidthPx: 800,
    laneHeightPx: 44,
    cellAspect: 16 / 9,
    durationMs: 60_000,
    ...overrides,
  };
}

describe('frameRect', () => {
  it('reads the first frame from the top left corner', () => {
    expect(frameRect(sheet(), 0)).toEqual({ sx: 0, sy: 0, sw: 160, sh: 90 });
  });

  it('walks along the first row as time advances', () => {
    // Three seconds in, at one frame a second, is the fourth cell across.
    expect(frameRect(sheet(), 3000)).toEqual({ sx: 480, sy: 0, sw: 160, sh: 90 });
  });

  it('keeps showing a frame until the next interval starts', () => {
    // Every instant between two boundaries maps to the earlier frame, so the
    // strip does not flicker between two thumbnails at a boundary.
    expect(frameRect(sheet(), 3001)).toEqual(frameRect(sheet(), 3000));
    expect(frameRect(sheet(), 3999)).toEqual(frameRect(sheet(), 3000));
    expect(frameRect(sheet(), 4000)).not.toEqual(frameRect(sheet(), 3000));
  });

  it('wraps to the next row past the last column', () => {
    // Frame 10 is the first of row 1, not the eleventh of row 0.
    expect(frameRect(sheet(), 10_000)).toEqual({ sx: 0, sy: 90, sw: 160, sh: 90 });
  });

  it('finds a frame deep in the grid', () => {
    // Frame 47: row 4, column 7.
    expect(frameRect(sheet(), 47_000)).toEqual({ sx: 1120, sy: 360, sw: 160, sh: 90 });
  });

  it('clamps to the last frame past the end of the recording', () => {
    // The lane's last cell can round a few milliseconds past the final
    // boundary. Returning null there would leave a hole at the end of every
    // strip.
    const last = frameRect(sheet(), 59_000);

    expect(frameRect(sheet(), 60_000)).toEqual(last);
    expect(frameRect(sheet(), 10_000_000)).toEqual(last);
  });

  it('clamps to the first frame before the start', () => {
    expect(frameRect(sheet(), -5000)).toEqual(frameRect(sheet(), 0));
  });

  it('survives a nonsense time', () => {
    expect(frameRect(sheet(), Number.NaN)).toEqual(frameRect(sheet(), 0));
  });

  it('never reads outside the sheet, at any instant', () => {
    // The failure this guards is a source rect past the image edge, which
    // draws nothing at all — a blank lane rather than a wrong thumbnail.
    const geometry = sheet({ frameCount: 65 });
    const sheetWidth = geometry.columns * geometry.frameWidth;
    const sheetHeight = Math.ceil(geometry.frameCount / geometry.columns) * geometry.frameHeight;

    for (let timeMs = -2000; timeMs <= 70_000; timeMs += 137) {
      const rect = frameRect(geometry, timeMs);
      expect(rect).not.toBeNull();
      expect(rect!.sx).toBeGreaterThanOrEqual(0);
      expect(rect!.sy).toBeGreaterThanOrEqual(0);
      expect(rect!.sx + rect!.sw).toBeLessThanOrEqual(sheetWidth);
      expect(rect!.sy + rect!.sh).toBeLessThanOrEqual(sheetHeight);
    }
  });

  it('refuses an empty sheet', () => {
    expect(frameRect(sheet({ frameCount: 0 }), 0)).toBeNull();
    expect(frameRect(sheet({ columns: 0 }), 0)).toBeNull();
  });

  it('refuses a sheet with no interval', () => {
    // Dividing by it would put every cell on frame 0 or NaN.
    expect(frameRect(sheet({ intervalMs: 0 }), 5000)).toBeNull();
  });
});

describe('filmstripCells', () => {
  it('sizes each cell to the lane height and the source aspect', () => {
    // 44px tall at 16:9 is 78.2px wide.
    const cells = filmstripCells(layout());

    expect(cells[0].widthPx).toBeCloseTo((44 * 16) / 9, 5);
  });

  it('gives a portrait source narrower cells than a landscape one', () => {
    const wide = filmstripCells(layout({ cellAspect: 16 / 9 }));
    const tall = filmstripCells(layout({ cellAspect: 3 / 4 }));

    expect(tall[0].widthPx).toBeLessThan(wide[0].widthPx);
    expect(tall.length).toBeGreaterThan(wide.length);
  });

  it('lays the cells edge to edge with no gaps', () => {
    const cells = filmstripCells(layout());

    for (let index = 1; index < cells.length; index += 1) {
      expect(cells[index].xPx).toBeCloseTo(cells[index - 1].xPx + cells[index - 1].widthPx, 5);
    }
  });

  it('starts at the left edge at time zero', () => {
    const cells = filmstripCells(layout());

    expect(cells[0].xPx).toBe(0);
    expect(cells[0].timeMs).toBe(0);
  });

  it('covers the whole lane', () => {
    // The last cell has to start before the right edge and reach past it, or
    // the tail of the lane is bare.
    const cells = filmstripCells(layout());
    const last = cells[cells.length - 1];

    expect(last.xPx).toBeLessThan(800);
    expect(last.xPx + last.widthPx).toBeGreaterThanOrEqual(800);
  });

  it('maps a cell position to the matching instant', () => {
    // A cell halfway along a lane showing a minute of footage is at 30s.
    const cells = filmstripCells(layout());
    const halfway = cells.find((cell) => cell.xPx >= 400)!;

    expect(halfway.timeMs).toBeCloseTo((halfway.xPx / 800) * 60_000, 5);
  });

  it('produces more cells as the lane gets wider', () => {
    // The timeline zooms by widening its track, and the strip has to follow.
    const narrow = filmstripCells(layout({ laneWidthPx: 400 }));
    const wide = filmstripCells(layout({ laneWidthPx: 1600 }));

    expect(wide.length).toBeGreaterThan(narrow.length);
  });

  it('spreads the same footage over a wider lane rather than showing less of it', () => {
    // Widening the lane must not truncate the recording: the strip still runs
    // to the end of the footage.
    //
    // The claim is about the span the last cell *covers*, not where it starts.
    // A cell's time is its left edge, and that edge can sit up to a full cell
    // short of the lane's right edge — on a 200px lane a cell is 39% of the
    // lane, so asking the last edge to land near the end is asking for
    // something no integer number of cells can give.
    for (const laneWidthPx of [200, 800, 3000]) {
      const cells = filmstripCells(layout({ laneWidthPx }));
      const last = cells[cells.length - 1];
      const spanMs = (last.widthPx / laneWidthPx) * 60_000;

      expect(last.timeMs).toBeLessThanOrEqual(60_000);
      expect(last.timeMs + spanMs).toBeGreaterThanOrEqual(60_000);
    }
  });

  it('caps the cell count on a deeply zoomed lane', () => {
    const cells = filmstripCells(layout({ laneWidthPx: 200_000 }));

    expect(cells.length).toBeLessThanOrEqual(MAX_FILMSTRIP_CELLS);
  });

  it('still covers a capped lane edge to edge', () => {
    // Hitting the cap must widen the cells, not leave most of the lane blank.
    const cells = filmstripCells(layout({ laneWidthPx: 200_000 }));
    const last = cells[cells.length - 1];

    expect(last.xPx + last.widthPx).toBeGreaterThanOrEqual(200_000);
  });

  it('draws nothing for a lane with no width', () => {
    expect(filmstripCells(layout({ laneWidthPx: 0 }))).toEqual([]);
    expect(filmstripCells(layout({ laneWidthPx: -10 }))).toEqual([]);
  });

  it('draws nothing when the geometry is nonsense', () => {
    expect(filmstripCells(layout({ cellAspect: 0 }))).toEqual([]);
    expect(filmstripCells(layout({ cellAspect: Number.NaN }))).toEqual([]);
    expect(filmstripCells(layout({ laneHeightPx: 0 }))).toEqual([]);
  });

  it('still lays out a strip for a recording of no length', () => {
    // A zero-duration project still opens, and its lane still draws. Every
    // cell shows the one frame there is.
    const cells = filmstripCells(layout({ durationMs: 0 }));

    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((cell) => cell.timeMs === 0)).toBe(true);
  });
});
