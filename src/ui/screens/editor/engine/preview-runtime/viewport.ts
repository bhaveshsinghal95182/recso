import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

import type { CanvasSize } from '../preview-config/types';

const EMPTY_SIZE: CanvasSize = {
  width: 0,
  height: 0,
};

export function usePreviewViewportSize(viewportRef: RefObject<HTMLDivElement | null>): CanvasSize {
  const [availableSize, setAvailableSize] = useState<CanvasSize>(EMPTY_SIZE);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const updateSize = (): void => {
      setAvailableSize({
        width: Math.max(0, viewport.clientWidth),
        height: Math.max(0, viewport.clientHeight),
      });
    };

    updateSize();

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      setAvailableSize({
        width: Math.max(0, Math.round(entry.contentRect.width)),
        height: Math.max(0, Math.round(entry.contentRect.height)),
      });
    });

    observer.observe(viewport);

    return () => {
      observer.disconnect();
    };
  }, [viewportRef]);

  return availableSize;
}
