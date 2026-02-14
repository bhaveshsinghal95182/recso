import { create } from 'zustand';

import { debounce } from '../lib/utils';
import type { CutRegion, ZoomRegion } from '../types';

interface TimelineState {
  cuts: CutRegion[];
  zoomRegions: ZoomRegion[];
  selectedCutId: string | null;
  selectedZoomId: string | null;
  isEditingFocalPoint: boolean;

  // Actions
  setCuts: (cuts: CutRegion[]) => void;
  setZoomRegions: (zooms: ZoomRegion[]) => void;

  addCut: (startMs: number, endMs: number) => Promise<void>;
  removeCut: (cutId: string) => Promise<void>;
  updateCut: (cut: CutRegion) => Promise<void>;
  setSelectedCut: (cutId: string | null) => void;

  addZoom: (startMs: number, endMs: number) => Promise<void>;
  removeZoom: (zoomId: string) => Promise<void>;
  updateZoom: (zoom: ZoomRegion) => Promise<void>;
  updateZoomRegions: (zooms: ZoomRegion[]) => Promise<void>;
  replaceZoomRegions: (zooms: ZoomRegion[]) => Promise<void>;
  setSelectedZoom: (zoomId: string | null) => void;
  setIsEditingFocalPoint: (isEditing: boolean) => void;

  // Reset
  reset: () => void;
}

// Debounced IPC calls
const debouncedUpdateZoom = debounce(async (zoom: ZoomRegion) => {
  try {
    await window.electron.editor.updateZoomRegion(zoom);
  } catch (err) {
    console.error('[TimelineStore] updateZoom error:', err);
  }
}, 300);

export const useTimelineStore = create<TimelineState>((set) => ({
  cuts: [],
  zoomRegions: [],
  selectedCutId: null,
  selectedZoomId: null,
  isEditingFocalPoint: false,

  setCuts: (cuts) => set({ cuts: cuts.sort((a, b) => a.startMs - b.startMs) }),
  setZoomRegions: (zoomRegions) =>
    set({ zoomRegions: zoomRegions.sort((a, b) => a.startMs - b.startMs) }),

  addCut: async (startMs, endMs) => {
    const newCut: CutRegion = { id: crypto.randomUUID(), startMs, endMs };
    try {
      await window.electron.editor.addCut(newCut);
      set((state) => ({
        cuts: [...state.cuts, newCut].sort((a, b) => a.startMs - b.startMs),
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
      await window.electron.editor.updateCut(cut);
      set((state) => ({
        cuts: state.cuts
          .map((c) => (c.id === cut.id ? cut : c))
          .sort((a, b) => a.startMs - b.startMs),
      }));
    } catch (err) {
      console.error('[TimelineStore] updateCut error:', err);
    }
  },

  setSelectedCut: (cutId) => set({ selectedCutId: cutId }),

  addZoom: async (startMs, endMs) => {
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
      await window.electron.editor.addZoomRegion(newZoom);
      set((state) => ({
        zoomRegions: [...state.zoomRegions, newZoom].sort((a, b) => a.startMs - b.startMs),
      }));
    } catch (err) {
      console.error('[TimelineStore] addZoom error:', err);
    }
  },

  removeZoom: async (zoomId) => {
    try {
      await window.electron.editor.removeZoomRegion(zoomId);
      set((state) => ({
        zoomRegions: state.zoomRegions.filter((z) => z.id !== zoomId),
        selectedZoomId: state.selectedZoomId === zoomId ? null : state.selectedZoomId,
      }));
    } catch (err) {
      console.error('[TimelineStore] removeZoom error:', err);
    }
  },

  updateZoom: async (zoom) => {
    // Optimistic update
    set((state) => ({
      zoomRegions: state.zoomRegions
        .map((z) => (z.id === zoom.id ? zoom : z))
        .sort((a, b) => a.startMs - b.startMs),
    }));

    debouncedUpdateZoom(zoom);
  },

  updateZoomRegions: async (zooms) => {
    try {
      await window.electron.editor.updateZoomRegions(zooms);
      set((state) => ({
        zoomRegions: state.zoomRegions
          .map((z) => zooms.find((u) => u.id === z.id) || z)
          .sort((a, b) => a.startMs - b.startMs),
      }));
    } catch (err) {
      console.error('[TimelineStore] updateZoomRegions error:', err);
    }
  },

  replaceZoomRegions: async (zooms) => {
    try {
      // Logic from context: remove existing, add new.
      // BE implementation might vary but sticking to Context logic for now.
      const currentZooms = await window.electron.editor.getZoomRegions();
      for (const z of currentZooms) await window.electron.editor.removeZoomRegion(z.id);
      for (const z of zooms) await window.electron.editor.addZoomRegion(z);

      const sorted = [...zooms].sort((a, b) => a.startMs - b.startMs);
      set({ zoomRegions: sorted });
    } catch (err) {
      console.error('[TimelineStore] replaceZoomRegions error:', err);
    }
  },

  setSelectedZoom: (zoomId) => set({ selectedZoomId: zoomId }),
  setIsEditingFocalPoint: (isEditing) => set({ isEditingFocalPoint: isEditing }),

  reset: () =>
    set({
      cuts: [],
      zoomRegions: [],
      selectedCutId: null,
      selectedZoomId: null,
      isEditingFocalPoint: false,
    }),
}));
