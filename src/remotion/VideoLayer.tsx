import { Video } from '@remotion/media';
import React from 'react';
import { staticFile } from 'remotion';

import type { RemotionInputProps } from './types';

export const VideoLayer: React.FC<RemotionInputProps> = React.memo(({ videoSrc, layout }) => {
  // If videoSrc is a URL (http/file) use as is, otherwise treat as static file
  const src =
    videoSrc.startsWith('http') || videoSrc.startsWith('file:') ? videoSrc : staticFile(videoSrc);

  return (
    <div
      style={{
        position: 'absolute',
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
        // Glassmorphic border container
        padding: 12, // Thickness of the "glass" border
        backgroundColor: 'rgba(255, 255, 255, 0.1)', // Translucent fill
        backdropFilter: 'blur(10px)', // Blur effect
        WebkitBackdropFilter: 'blur(10px)',
        border: '8px solid rgba(255, 255, 255, 0.2)', // Subtle edge
        borderRadius: 24, // Rounded corners for the container
        boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.05)', // Depth
        boxSizing: 'border-box',
        overflow: 'hidden',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Video
        src={src}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          borderRadius: 16, // Slightly smaller radius for nested video
        }}
      />
    </div>
  );
});
