import { app } from 'electron';

import { getEngineBindings } from './native.js';

/**
 * Which GPU is the engine on, and is Chromium on the same one?
 *
 * A shared texture handle is only meaningful to the adapter that created it.
 * If these two disagree the preview goes black or garbled while every layer
 * reports success, which is close to impossible to read backwards from the
 * symptom -- so it gets checked once at startup and said out loud.
 */
export interface GpuSummary {
  engine: string;
  chromium: string;
  matched: boolean;
}

const VENDORS = ['NVIDIA', 'AMD', 'Radeon', 'Intel'] as const;

let summary: GpuSummary | null = null;

export function gpuSummary(): GpuSummary | null {
  return summary;
}

export async function checkGpuMatch(): Promise<void> {
  const bindings = getEngineBindings();
  if (!bindings) {
    return;
  }

  try {
    const lines = bindings.adapterInfo();
    const active = (lines.find((line) => line.startsWith('active:')) ?? '').replace('active: ', '');

    // `complete` triggers additional driver probing. With Electron 40 in AppX,
    // that loads vulkan-1.dll after GPU sandbox lockdown: Code Integrity 3033
    // kills the GPU process and marks the whole package NeedsRemediation.
    // Basic info reads Chromium's cached adapter data without that probe.
    const info = await app.getGPUInfo('basic');
    const chromium =
      (info as { auxAttributes?: { glRenderer?: string } }).auxAttributes?.glRenderer ?? '';

    console.log('[engine][gpu] engine  :', active || '(unknown)');
    console.log('[engine][gpu] chromium:', chromium || '(unavailable)');

    const vendor = VENDORS.find((v) => active.includes(v));
    const matched = !vendor || !chromium || chromium.includes(vendor);

    summary = {
      engine: active || 'unknown',
      chromium: chromium || 'unavailable',
      matched,
    };

    if (!matched) {
      console.warn(
        `[engine][gpu] MISMATCH: engine is on ${vendor} but Chromium is not. ` +
          'Shared textures cannot cross adapters, so the GPU preview will not ' +
          'work. Set RECSO_ENGINE_GPU=integrated to put both on the default adapter.',
      );
    }
  } catch (error) {
    console.warn('[engine][gpu] could not compare adapters:', (error as Error).message);
  }
}
