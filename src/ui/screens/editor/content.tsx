import { useEffect } from 'react';

import { usePlaybackStore } from '@/store/playback-store';
import { useProjectStore } from '@/store/project-store';
import { useTimelineStore } from '@/store/timeline-store';

import { EditorLayout } from './editor-layout';
import { MinimalPreview } from './preview';
import { PropertiesPanel } from './properties-panel';
import { Timeline } from './timeline';

export function EditorContent() {
  const { project, isLoading, error } = useProjectStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      console.log('key ', e.code);

      const activeEl = document.activeElement;
      const activeTag = activeEl?.tagName.toLowerCase();

      // Don't toggle if user is typing in an input or textarea
      const isInput =
        activeTag === 'input' ||
        activeTag === 'textarea' ||
        (activeEl as HTMLElement)?.isContentEditable;

      if (isInput) return;

      // Only trigger on Spacebar
      if (e.code === 'Space') {
        e.preventDefault();
        const { isPlaying, play, pause } = usePlaybackStore.getState();
        if (isPlaying) {
          pause();
        } else {
          play();
        }
      }

      if (e.code === 'ArrowRight') {
        e.preventDefault();
        const { seek, pause, currentTime } = usePlaybackStore.getState();
        pause(); // Pause when seeking with arrow keys
        seek(currentTime + 1000); // Seek forward 1 second
      }

      if (e.code === 'ArrowLeft') {
        e.preventDefault();
        const { seek, pause, currentTime } = usePlaybackStore.getState();
        pause(); // Pause when seeking with arrow keys
        seek(currentTime - 1000); // Seek backward 1 second
      }

      if (e.code === 'BracketLeft') {
        e.preventDefault();
        const { addCut } = useTimelineStore.getState();
        const { currentTime } = usePlaybackStore.getState();
        if (currentTime + 2000 <= usePlaybackStore.getState().duration) {
          addCut(currentTime, currentTime + 2000);
        }
      }

      if (e.code === 'BracketRight') {
        e.preventDefault();
        const { addCut } = useTimelineStore.getState();
        const { currentTime } = usePlaybackStore.getState();
        if (currentTime >= 2000) {
          addCut(currentTime - 2000, currentTime);
        }
      }

      if (e.code === 'Backspace' || e.code === 'Delete') {
        e.preventDefault();
        const { currentTime } = usePlaybackStore.getState();
        const { cuts, zoomRegions, removeCut, removeZoom } = useTimelineStore.getState();
        if (cuts.some((cut) => currentTime >= cut.startMs && currentTime <= cut.endMs)) {
          const cutToRemove = cuts.find(
            (cut) => currentTime >= cut.startMs && currentTime <= cut.endMs,
          );
          if (cutToRemove) {
            removeCut(cutToRemove.id);
          }
        } else if (
          zoomRegions.some((zoom) => currentTime >= zoom.startMs && currentTime <= zoom.endMs)
        ) {
          const zoomToRemove = zoomRegions.find(
            (zoom) => currentTime >= zoom.startMs && currentTime <= zoom.endMs,
          );
          if (zoomToRemove) {
            removeZoom(zoomToRemove.id);
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
