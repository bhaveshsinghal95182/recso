/**
 * Export Progress Store
 *
 * Global state for export progress tracking that persists
 * even when the export modal is closed.
 */

import { create } from 'zustand';

import type { ExportProgress, ExportResult } from '@/types';

export type ExportState = 'idle' | 'exporting' | 'complete' | 'error';

interface ExportStoreState {
  /** Current export state */
  state: ExportState;

  /** Current export progress (null when not exporting) */
  progress: ExportProgress | null;

  /** Export result (for complete/error states) */
  result: ExportResult | null;

  /** Whether the export modal is open */
  isModalOpen: boolean;

  /** Actions */
  setExportState: (state: ExportState) => void;
  setProgress: (progress: ExportProgress | null) => void;
  setResult: (result: ExportResult | null) => void;
  setModalOpen: (open: boolean) => void;
  reset: () => void;
}

export const useExportStore = create<ExportStoreState>((set) => ({
  state: 'idle',
  progress: null,
  result: null,
  isModalOpen: false,

  setExportState: (state) => set({ state }),
  setProgress: (progress) => set({ progress }),
  setResult: (result) => set({ result }),
  setModalOpen: (isModalOpen) => set({ isModalOpen }),

  reset: () =>
    set({
      state: 'idle',
      progress: null,
      result: null,
    }),
}));
