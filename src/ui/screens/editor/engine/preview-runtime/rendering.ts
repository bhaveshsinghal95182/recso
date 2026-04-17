import type { MutableRefObject } from 'react';

import type { CanvasFrameContext } from '../adapters';
import type { CompositionEngine } from '../engine';

export interface RenderEngineFrameSafelyOptions {
  previewContext: CanvasFrameContext | null;
  engine: CompositionEngine;
  previewErrorLoggedRef: MutableRefObject<boolean>;
  errorScope: string;
}

export function renderEngineFrameSafely({
  previewContext,
  engine,
  previewErrorLoggedRef,
  errorScope,
}: RenderEngineFrameSafelyOptions): boolean {
  if (!previewContext) {
    return false;
  }

  try {
    const context2d = previewContext.get2DContext();
    context2d.clearRect(0, 0, previewContext.width, previewContext.height);
    engine.renderCurrentFrame(previewContext);

    previewErrorLoggedRef.current = false;
    return true;
  } catch (error) {
    if (!previewErrorLoggedRef.current) {
      previewErrorLoggedRef.current = true;
      console.error(`[EnginePreview] ${errorScope} failed:`, error);
    }

    return false;
  }
}
