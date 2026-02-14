import React from 'react';
import { Video } from 'remotion';

import type { RemotionInputProps } from './types';

/**
 * VideoLayer: Renders the source video at the calculated layout position.
 *
 * Layout is pre-calculated, ensuring WYSIWYG consistency between
 * the editor preview and exported video.
 */
export const VideoLayer: React.FC<RemotionInputProps> = ({ videoSrc, layout }) => {
  return (
    <Video
      src={videoSrc}
      style={{
        position: 'absolute',
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
      }}
    />
  );
};
