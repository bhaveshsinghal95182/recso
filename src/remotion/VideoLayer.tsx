import { Video } from '@remotion/media';
import React from 'react';
import { staticFile } from 'remotion';

import type { RemotionInputProps } from './types';

export const VideoLayer: React.FC<RemotionInputProps> = React.memo(({ videoSrc, layout }) => {
  // If videoSrc is a URL (http/file) use as is, otherwise treat as static file
  const src =
    videoSrc.startsWith('http') || videoSrc.startsWith('file:') ? videoSrc : staticFile(videoSrc);

  return (
    <Video
      src={src}
      style={{
        position: 'absolute',
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
      }}
    />
  );
});
