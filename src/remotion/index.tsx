import { Composition, registerRoot } from 'remotion';

import { MainComposition } from './Composition';
import type { RemotionInputProps } from './types';

/**
 * Remotion Entry Point.
 *
 * This file is loaded by @remotion/bundler when bundling.
 * It must export a default component with <Composition> definitions
 * and call registerRoot() for bundler to recognize it.
 *
 * Note: All placeholder values (width, height, fps, durationInFrames)
 * are overridden at render time via inputProps and composition overrides
 * in the remotion-renderer service.
 */
function RemotionRoot() {
  return (
    <>
      <Composition
        id="main"
        component={MainComposition}
        // Placeholders — real values provided at render time
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={
          {
            project: {},
            config: {},
            layout: {},
            canvasWidth: 1920,
            canvasHeight: 1080,
          } as unknown as RemotionInputProps
        }
      />
    </>
  );
}

// Register composition with Remotion bundler
registerRoot(RemotionRoot);

// Named exports for direct imports
export { MainComposition };
export type { RemotionInputProps };
