import type { ExportConfig } from '@/types';

import type { OutputDimensions } from './types';

export function resolveOutputDimensions(config: ExportConfig): OutputDimensions {
  switch (config.resolution) {
    case '720p':
      return { width: 1280, height: 720 };
    case '4k':
      return { width: 3840, height: 2160 };
    case 'custom':
      return {
        width: Math.max(2, config.customWidth ?? 1920),
        height: Math.max(2, config.customHeight ?? 1080),
      };
    case '1080p':
    default:
      return { width: 1920, height: 1080 };
  }
}

export function resolveVideoBitrate(config: ExportConfig): number {
  switch (config.quality) {
    case 'low':
      return 4_000_000;
    case 'medium':
      return 8_000_000;
    case 'lossless':
      return 20_000_000;
    case 'high':
    default:
      return 12_000_000;
  }
}
