import { create } from 'zustand';

import { debounce } from '../lib/utils';
import type { CutRegion, ZoomRegion, ZoomRegionsBySource, ZoomSource } from '../types';

const DEFAULT_ZOOM_SOURCE: ZoomSource = 'screen';

/**
 * The single region the properties panel is editing.
 *
 * Focus is genuinely exclusive — focusing a cut un-focuses any zoom or cursor
 * region — so it is one value rather than three nullable ids that callers have
 * to null out by hand. `editingFocalPoint` rides on the zoom variant because
 * it is only meaningful while a zoom is focused.
 *
 * Note this is NOT the marquee multi-selection: a box drag in 'all' mode can
 * span cuts, zooms and cursor regions at once, so that stays a set per type.
 */
export type TimelineFocus =
  | { kind: 'none' }
  | { kind: 'cut'; id: string }
  | { kind: 'zoom'; id: string; editingFocalPoint: boolean }
  | { kind: 'cursorRegion'; id: string };

const NO_FOCUS: TimelineFocus = { kind: 'none' };

export const focusedCutId = (focus: TimelineFocus): string | null =>
  focus.kind === 'cut' ? focus.id : null;

export const focusedZoomId = (focus: TimelineFocus): string | null =>
  focus.kind === 'zoom' ? focus.id : null;

export const focusedCursorRegionId = (focus: TimelineFocus): string | null =>
  focus.kind === 'cursorRegion' ? focus.id : null;

export const isEditingFocalPoint = (focus: TimelineFocus): boolean =>
  focus.kind === 'zoom' && focus.editingFocalPoint;

function sortZoomRegions(zoomRegions: ZoomRegion[]): ZoomRegion[] {
  return [...zoomRegions].sort((a, b) => a.startMs - b.startMs);
}

function normalizeZoomRegionsBySource(
  zoomRegionsBySource?: Partial<ZoomRegionsBySource>,
): ZoomRegionsBySource {
  return {
    screen: sortZoomRegions(zoomRegionsBySource?.screen ?? []),
    webcam: sortZoomRegions(zoomRegionsBySource?.webcam ?? []),
  };
}

function normalizeCutRegion(cut: CutRegion): CutRegion {
  return {
    ...cut,
    targets: {
      screen: cut.targets?.screen ?? true,
      webcam: cut.targets?.webcam ?? true,
    },
  };
}

function normalizeCuts(cuts: CutRegion[]): CutRegion[] {
  if (!Array.isArray(cuts)) return [];

  const normalized = [...cuts]
    .map((c) => {
      const n = normalizeCutRegion(c);
      return {
        ...n,
        startMs: Math.max(0, Math.min(Number(n.startMs) || 0, Number(n.endMs) || 0)),
        endMs: Math.max(0, Number(n.endMs) || 0),
      } as CutRegion;
    })
    .filter((c) => Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > c.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged: CutRegion[] = [];
  for (const cut of normalized) {
    if (merged.length === 0) {
      merged.push({ ...cut });
      continue;
    }

    const last = merged[merged.length - 1];
    if (cut.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, cut.endMs);
      last.targets = {
        screen: (last.targets?.screen ?? true) || (cut.targets?.screen ?? true),
        webcam: (last.targets?.webcam ?? true) || (cut.targets?.webcam ?? true),
      };
    } else {
      merged.push({ ...cut });
    }
  }

  return merged;
}

interface TimelineState {
  cuts: CutRegion[];
  zoomSource: ZoomSource;
  zoomRegions: ZoomRegion[];
  zoomRegionsBySource: ZoomRegionsBySource;
  focus: TimelineFocus;

  // Actions
  setCuts: (cuts: CutRegion[]) => void;
  setZoomRegions: (zooms: ZoomRegion[], source?: ZoomSource) => void;
  setZoomRegionsBySource: (zoomRegionsBySource: Partial<ZoomRegionsBySource>) => void;
  setZoomSource: (source: ZoomSource) => Promise<void>;

  addCut: (startMs: number, endMs: number, targets?: CutRegion['targets']) => Promise<void>;
  removeCut: (cutId: string) => Promise<void>;
  updateCut: (cut: CutRegion) => Promise<void>;
  focusCut: (cutId: string) => void;

  addZoom: (startMs: number, endMs: number, source?: ZoomSource) => Promise<void>;
  removeZoom: (zoomId: string, source?: ZoomSource) => Promise<void>;
  updateZoom: (zoom: ZoomRegion, source?: ZoomSource) => Promise<void>;
  updateZoomRegions: (zooms: ZoomRegion[], source?: ZoomSource) => Promise<void>;
  replaceZoomRegions: (zooms: ZoomRegion[], source?: ZoomSource) => Promise<void>;
  focusZoom: (zoomId: string) => void;
  focusCursorRegion: (regionId: string) => void;
  clearFocus: () => void;
  setEditingFocalPoint: (isEditing: boolean) => void;

  // Reset
  reset: () => void;
}

// Debounced IPC calls
const debouncedUpdateZoom = debounce(async (source: ZoomSource, zoom: ZoomRegion) => {
  try {
    await window.electron.editor.updateZoomRegionBySource(source, zoom);
  } catch (err) {
    console.error('[TimelineStore] updateZoom error:', err);
  }
}, 300);

export const useTimelineStore = create<TimelineState>((set, get) => ({
  cuts: [],
  zoomSource: DEFAULT_ZOOM_SOURCE,
  zoomRegions: [],
  zoomRegionsBySource: {
    screen: [],
    webcam: [],
  },
  focus: NO_FOCUS,

  setCuts: (cuts) => set({ cuts: normalizeCuts(cuts) }),
  setZoomRegions: (zoomRegions, source) => {
    const resolvedSource = source ?? get().zoomSource;
    const sortedZoomRegions = sortZoomRegions(zoomRegions);
    set((state) => {
      const nextBySource: ZoomRegionsBySource = {
        ...state.zoomRegionsBySource,
        [resolvedSource]: sortedZoomRegions,
      };

      return {
        zoomRegionsBySource: nextBySource,
        zoomRegions: resolvedSource === state.zoomSource ? sortedZoomRegions : state.zoomRegions,
      };
    });
  },

  setZoomRegionsBySource: (zoomRegionsBySource) => {
    set((state) => {
      const merged = normalizeZoomRegionsBySource({
        screen: zoomRegionsBySource.screen ?? state.zoomRegionsBySource.screen,
        webcam: zoomRegionsBySource.webcam ?? state.zoomRegionsBySource.webcam,
      });

      return {
        zoomRegionsBySource: merged,
        zoomRegions: merged[state.zoomSource],
      };
    });
  },

  setZoomSource: async (source) => {
    try {
      const zoomRegions = await window.electron.editor.getZoomRegionsBySource(source);
      const sortedZoomRegions = sortZoomRegions(zoomRegions);

      set((state) => {
        const nextBySource: ZoomRegionsBySource = {
          ...state.zoomRegionsBySource,
          [source]: sortedZoomRegions,
        };

        return {
          zoomSource: source,
          zoomRegionsBySource: nextBySource,
          zoomRegions: sortedZoomRegions,
          focus:
            state.focus.kind === 'zoom' &&
            !sortedZoomRegions.some((zoom) => zoom.id === focusedZoomId(state.focus))
              ? NO_FOCUS
              : state.focus,
        };
      });
    } catch (err) {
      console.error('[TimelineStore] setZoomSource error:', err);
    }
  },

  addCut: async (startMs, endMs, targets) => {
    const newCut: CutRegion = {
      id: crypto.randomUUID(),
      startMs,
      endMs,
      targets: {
        screen: targets?.screen ?? true,
        webcam: targets?.webcam ?? true,
      },
    };
    try {
      await window.electron.editor.addCut(newCut);
      set((state) => ({
        cuts: normalizeCuts([...state.cuts, newCut]),
      }));
    } catch (err) {
      console.error('[TimelineStore] addCut error:', err);
    }
  },

  removeCut: async (cutId) => {
    try {
      await window.electron.editor.removeCut(cutId);
      set((state) => ({
        cuts: state.cuts.filter((c) => c.id !== cutId),
        focus: state.focus.kind === 'cut' && state.focus.id === cutId ? NO_FOCUS : state.focus,
      }));
    } catch (err) {
      console.error('[TimelineStore] removeCut error:', err);
    }
  },

  updateCut: async (cut) => {
    try {
      const normalizedCut = normalizeCutRegion(cut);
      await window.electron.editor.updateCut(normalizedCut);
      set((state) => ({
        cuts: normalizeCuts(state.cuts.map((c) => (c.id === normalizedCut.id ? normalizedCut : c))),
      }));
    } catch (err) {
      console.error('[TimelineStore] updateCut error:', err);
    }
  },

  focusCut: (cutId) => set({ focus: { kind: 'cut', id: cutId } }),

  addZoom: async (startMs, endMs, source) => {
    const resolvedSource = source ?? get().zoomSource;
    const newZoom: ZoomRegion = {
      id: crypto.randomUUID(),
      startMs,
      endMs,
      zoomLevel: 1.5,
      focalX: 0.5,
      focalY: 0.5,
      easeDurationMs: 300,
    };
    try {
      await window.electron.editor.addZoomRegionBySource(resolvedSource, newZoom);
      set((state) => ({
        zoomRegionsBySource: {
          ...state.zoomRegionsBySource,
          [resolvedSource]: sortZoomRegions([
            ...state.zoomRegionsBySource[resolvedSource],
            newZoom,
          ]),
        },
        zoomRegions:
          resolvedSource === state.zoomSource
            ? sortZoomRegions([...state.zoomRegions, newZoom])
            : state.zoomRegions,
      }));
    } catch (err) {
      console.error('[TimelineStore] addZoom error:', err);
    }
  },

  removeZoom: async (zoomId, source) => {
    const resolvedSource = source ?? get().zoomSource;
    try {
      await window.electron.editor.removeZoomRegionBySource(resolvedSource, zoomId);
      set((state) => ({
        zoomRegionsBySource: {
          ...state.zoomRegionsBySource,
          [resolvedSource]: state.zoomRegionsBySource[resolvedSource].filter(
            (z) => z.id !== zoomId,
          ),
        },
        zoomRegions:
          resolvedSource === state.zoomSource
            ? state.zoomRegions.filter((z) => z.id !== zoomId)
            : state.zoomRegions,
        focus: state.focus.kind === 'zoom' && state.focus.id === zoomId ? NO_FOCUS : state.focus,
      }));
    } catch (err) {
      console.error('[TimelineStore] removeZoom error:', err);
    }
  },

  updateZoom: async (zoom, source) => {
    const resolvedSource = source ?? get().zoomSource;
    // Optimistic update
    set((state) => ({
      zoomRegionsBySource: {
        ...state.zoomRegionsBySource,
        [resolvedSource]: sortZoomRegions(
          state.zoomRegionsBySource[resolvedSource].map((z) => (z.id === zoom.id ? zoom : z)),
        ),
      },
      zoomRegions:
        resolvedSource === state.zoomSource
          ? sortZoomRegions(state.zoomRegions.map((z) => (z.id === zoom.id ? zoom : z)))
          : state.zoomRegions,
    }));

    debouncedUpdateZoom(resolvedSource, zoom);
  },

  updateZoomRegions: async (zooms, source) => {
    const resolvedSource = source ?? get().zoomSource;
    try {
      await window.electron.editor.updateZoomRegionsBySource(resolvedSource, zooms);
      set((state) => ({
        zoomRegionsBySource: {
          ...state.zoomRegionsBySource,
          [resolvedSource]: sortZoomRegions(
            state.zoomRegionsBySource[resolvedSource].map(
              (existingZoom) =>
                zooms.find((updatedZoom) => updatedZoom.id === existingZoom.id) || existingZoom,
            ),
          ),
        },
        zoomRegions:
          resolvedSource === state.zoomSource
            ? sortZoomRegions(
                state.zoomRegions.map(
                  (existingZoom) =>
                    zooms.find((updatedZoom) => updatedZoom.id === existingZoom.id) || existingZoom,
                ),
              )
            : state.zoomRegions,
      }));
    } catch (err) {
      console.error('[TimelineStore] updateZoomRegions error:', err);
    }
  },

  replaceZoomRegions: async (zooms, source) => {
    const resolvedSource = source ?? get().zoomSource;
    try {
      // Logic from context: remove existing, add new.
      // BE implementation might vary but sticking to Context logic for now.
      const currentZooms = await window.electron.editor.getZoomRegionsBySource(resolvedSource);
      for (const z of currentZooms) {
        await window.electron.editor.removeZoomRegionBySource(resolvedSource, z.id);
      }
      for (const z of zooms) {
        await window.electron.editor.addZoomRegionBySource(resolvedSource, z);
      }

      const sorted = sortZoomRegions(zooms);
      set((state) => ({
        zoomRegionsBySource: {
          ...state.zoomRegionsBySource,
          [resolvedSource]: sorted,
        },
        zoomRegions: resolvedSource === state.zoomSource ? sorted : state.zoomRegions,
        focus:
          state.focus.kind === 'zoom' &&
          !sorted.some((zoom) => zoom.id === focusedZoomId(state.focus))
            ? NO_FOCUS
            : state.focus,
      }));
    } catch (err) {
      console.error('[TimelineStore] replaceZoomRegions error:', err);
    }
  },

  focusZoom: (zoomId) => set({ focus: { kind: 'zoom', id: zoomId, editingFocalPoint: false } }),
  focusCursorRegion: (regionId) => set({ focus: { kind: 'cursorRegion', id: regionId } }),
  clearFocus: () => set({ focus: NO_FOCUS }),

  // Focal-point editing only exists while a zoom is focused, so this is a no-op
  // otherwise rather than a flag that outlives its subject.
  setEditingFocalPoint: (isEditing) =>
    set((state) =>
      state.focus.kind === 'zoom'
        ? { focus: { ...state.focus, editingFocalPoint: isEditing } }
        : state,
    ),

  reset: () =>
    set({
      cuts: [],
      zoomSource: DEFAULT_ZOOM_SOURCE,
      zoomRegions: [],
      zoomRegionsBySource: {
        screen: [],
        webcam: [],
      },
      focus: NO_FOCUS,
    }),
}));
