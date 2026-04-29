import { create } from 'zustand';

import { debounce } from '../lib/utils';
import type { CutRegion, ZoomRegion, ZoomRegionsBySource, ZoomSource } from '../types';

const DEFAULT_ZOOM_SOURCE: ZoomSource = 'screen';

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
  return [...cuts].map(normalizeCutRegion).sort((a, b) => a.startMs - b.startMs);
}

interface TimelineState {
  cuts: CutRegion[];
  zoomSource: ZoomSource;
  zoomRegions: ZoomRegion[];
  zoomRegionsBySource: ZoomRegionsBySource;
  selectedCutId: string | null;
  selectedZoomId: string | null;
  selectedCursorRegionId: string | null;
  isEditingFocalPoint: boolean;

  // Actions
  setCuts: (cuts: CutRegion[]) => void;
  setZoomRegions: (zooms: ZoomRegion[], source?: ZoomSource) => void;
  setZoomRegionsBySource: (zoomRegionsBySource: Partial<ZoomRegionsBySource>) => void;
  setZoomSource: (source: ZoomSource) => Promise<void>;

  addCut: (startMs: number, endMs: number) => Promise<void>;
  removeCut: (cutId: string) => Promise<void>;
  updateCut: (cut: CutRegion) => Promise<void>;
  setSelectedCut: (cutId: string | null) => void;

  addZoom: (startMs: number, endMs: number, source?: ZoomSource) => Promise<void>;
  removeZoom: (zoomId: string, source?: ZoomSource) => Promise<void>;
  updateZoom: (zoom: ZoomRegion, source?: ZoomSource) => Promise<void>;
  updateZoomRegions: (zooms: ZoomRegion[], source?: ZoomSource) => Promise<void>;
  replaceZoomRegions: (zooms: ZoomRegion[], source?: ZoomSource) => Promise<void>;
  setSelectedZoom: (zoomId: string | null) => void;
  setSelectedCursorRegion: (regionId: string | null) => void;
  setIsEditingFocalPoint: (isEditing: boolean) => void;

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
  selectedCutId: null,
  selectedZoomId: null,
  selectedCursorRegionId: null,
  isEditingFocalPoint: false,

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
          selectedZoomId: sortedZoomRegions.some((zoom) => zoom.id === state.selectedZoomId)
            ? state.selectedZoomId
            : null,
        };
      });
    } catch (err) {
      console.error('[TimelineStore] setZoomSource error:', err);
    }
  },

  addCut: async (startMs, endMs) => {
    const newCut: CutRegion = {
      id: crypto.randomUUID(),
      startMs,
      endMs,
      targets: {
        screen: true,
        webcam: true,
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
        selectedCutId: state.selectedCutId === cutId ? null : state.selectedCutId,
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

  setSelectedCut: (cutId) => set({ selectedCutId: cutId }),

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
        selectedZoomId: state.selectedZoomId === zoomId ? null : state.selectedZoomId,
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
        selectedZoomId: sorted.some((zoom) => zoom.id === state.selectedZoomId)
          ? state.selectedZoomId
          : null,
      }));
    } catch (err) {
      console.error('[TimelineStore] replaceZoomRegions error:', err);
    }
  },

  setSelectedZoom: (zoomId) => set({ selectedZoomId: zoomId }),
  setSelectedCursorRegion: (regionId) => set({ selectedCursorRegionId: regionId }),
  setIsEditingFocalPoint: (isEditing) => set({ isEditingFocalPoint: isEditing }),

  reset: () =>
    set({
      cuts: [],
      zoomSource: DEFAULT_ZOOM_SOURCE,
      zoomRegions: [],
      zoomRegionsBySource: {
        screen: [],
        webcam: [],
      },
      selectedCutId: null,
      selectedZoomId: null,
      selectedCursorRegionId: null,
      isEditingFocalPoint: false,
    }),
}));
