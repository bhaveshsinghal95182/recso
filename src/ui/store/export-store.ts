/**
 * Export Progress Store
 *
 * Global state for export progress tracking that persists
 * even when the export modal is closed.
 */

import { create } from 'zustand';

import type { ExportProgress } from '@/types';

/** Payload carried by a successful export. */
export interface ExportSuccess {
  outputPath: string;
  duration?: number;
  fileSize?: number;
}

/**
 * The export lifecycle as a single value.
 *
 * Each phase owns the data that is only meaningful in that phase, so
 * "exporting with no progress" or "complete with no output path" are not
 * representable. Transitions are atomic — phase and payload move together.
 */
export type ExportPhase =
  | { kind: 'idle' }
  | { kind: 'exporting'; progress: ExportProgress }
  | { kind: 'complete'; result: ExportSuccess }
  | { kind: 'error'; message: string };

const INITIAL_PROGRESS: ExportProgress = {
  percent: 0,
  currentFrame: 0,
  totalFrames: 0,
  fps: 0,
  eta: 0,
  stage: 'composition',
  stagePercent: 0,
  phase: 'Starting',
  indeterminate: false,
};

interface ExportStoreState {
  /** Where the export currently is in its lifecycle */
  phase: ExportPhase;

  /**
   * Whether the export modal is open. Orthogonal to `phase` on purpose: an
   * export keeps running (and reporting progress to the toast) while the
   * modal is closed.
   */
  isModalOpen: boolean;

  /** Actions */
  startExport: () => void;
  reportProgress: (progress: ExportProgress) => void;
  completeExport: (result: ExportSuccess) => void;
  failExport: (message: string) => void;
  setModalOpen: (open: boolean) => void;
  reset: () => void;
}

export const useExportStore = create<ExportStoreState>((set) => ({
  phase: { kind: 'idle' },
  isModalOpen: false,

  startExport: () => set({ phase: { kind: 'exporting', progress: INITIAL_PROGRESS } }),

  // Late progress callbacks can land after the export already finished or was
  // cancelled; dropping them here keeps a stale frame count from resurrecting
  // the exporting phase.
  reportProgress: (progress) =>
    set((state) =>
      state.phase.kind === 'exporting' ? { phase: { kind: 'exporting', progress } } : state,
    ),

  completeExport: (result) => set({ phase: { kind: 'complete', result } }),

  failExport: (message) => set({ phase: { kind: 'error', message } }),

  setModalOpen: (isModalOpen) => set({ isModalOpen }),

  reset: () => set({ phase: { kind: 'idle' } }),
}));
