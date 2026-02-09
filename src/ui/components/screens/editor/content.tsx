import { useEffect, useRef } from 'react';

import { useEditor } from '../../../context/editor-context';
import { EditorLayout } from './editor-layout';
import { MinimalPreview } from './preview';
import { PropertiesPanel } from './properties-panel';
import { Timeline } from './timeline';

export function EditorContent() {
  const { project, isLoading, error, isPlaying, play, pause } = useEditor();

  // Use a ref to access current state in event listener without re-binding
  const playbackRef = useRef({ isPlaying, play, pause });

  useEffect(() => {
    playbackRef.current = { isPlaying, play, pause };
  }, [isPlaying, play, pause]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only trigger on Spacebar
      if (e.code === 'Space') {
        const activeEl = document.activeElement;
        const activeTag = activeEl?.tagName.toLowerCase();

        // Don't toggle if user is typing in an input or textarea
        const isInput =
          activeTag === 'input' ||
          activeTag === 'textarea' ||
          (activeEl as HTMLElement)?.isContentEditable;

        if (!isInput) {
          e.preventDefault();
          const { isPlaying, play, pause } = playbackRef.current;
          if (isPlaying) {
            pause();
          } else {
            play();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <div className="w-8 h-8 border-2 border-muted border-t-primary rounded-full animate-spin mb-3" />
        <p className="text-sm">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <p className="text-destructive">{error}</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <p>No project loaded</p>
      </div>
    );
  }

  return (
    <EditorLayout
      viewport={<MinimalPreview />}
      properties={<PropertiesPanel />}
      timeline={<Timeline />}
    />
  );
}
