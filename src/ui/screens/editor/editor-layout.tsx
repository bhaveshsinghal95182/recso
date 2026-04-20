/**
 * EditorLayout — Grid-based layout for the editor screen.
 *
 * Layout:
 * ┌───────────────────────┬──────────────┐
 * │    Preview Canvas     │  Properties  │
 * │      (Viewport)       │    Panel     │
 * ├───────────────────────┴──────────────┤
 * │              Timeline                 │
 * └───────────────────────────────────────┘
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

const TIMELINE_HEIGHT_STORAGE_KEY = 'recso.editor.timeline-height';
const SIDEBAR_WIDTH_STORAGE_KEY = 'recso.editor.sidebar-width';
const MIN_TIMELINE_HEIGHT_PX = 208;
const MIN_VIEWPORT_SECTION_HEIGHT_PX = 240;
const MIN_SIDEBAR_WIDTH_PX = 240;
const MIN_VIEWPORT_SECTION_WIDTH_PX = 560;

function readStoredDimension(storageKey: string): number | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readStoredTimelineHeight(): number | null {
  return readStoredDimension(TIMELINE_HEIGHT_STORAGE_KEY);
}

function readStoredSidebarWidth(): number | null {
  return readStoredDimension(SIDEBAR_WIDTH_STORAGE_KEY);
}

interface EditorLayoutProps {
  viewport: ReactNode;
  properties: ReactNode;
  timeline: ReactNode;
}

export function EditorLayout({ viewport, properties, timeline }: EditorLayoutProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const timelineDragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const sidebarDragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const [timelineHeight, setTimelineHeight] = useState<number>(() => {
    const storedHeight = readStoredTimelineHeight();
    if (storedHeight !== null) {
      return storedHeight;
    }

    if (typeof window === 'undefined') {
      return 320;
    }

    return Math.round(window.innerHeight * 0.34);
  });

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const storedWidth = readStoredSidebarWidth();
    if (storedWidth !== null) {
      return storedWidth;
    }

    return 280;
  });

  const getMaxTimelineHeight = useCallback(() => {
    const rootHeight = rootRef.current?.clientHeight ?? window.innerHeight;
    return Math.max(MIN_TIMELINE_HEIGHT_PX, rootHeight - MIN_VIEWPORT_SECTION_HEIGHT_PX);
  }, []);

  const getMaxSidebarWidth = useCallback(() => {
    const rootWidth = rootRef.current?.clientWidth ?? window.innerWidth;
    return Math.max(MIN_SIDEBAR_WIDTH_PX, rootWidth - MIN_VIEWPORT_SECTION_WIDTH_PX);
  }, []);

  const clampTimelineHeight = useCallback(
    (height: number) => {
      const rounded = Math.round(height);
      return Math.min(getMaxTimelineHeight(), Math.max(MIN_TIMELINE_HEIGHT_PX, rounded));
    },
    [getMaxTimelineHeight],
  );

  const clampSidebarWidth = useCallback(
    (width: number) => {
      const rounded = Math.round(width);
      return Math.min(getMaxSidebarWidth(), Math.max(MIN_SIDEBAR_WIDTH_PX, rounded));
    },
    [getMaxSidebarWidth],
  );

  const handleTimelineResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();

      timelineDragStateRef.current = {
        startY: event.clientY,
        startHeight: timelineHeight,
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const dragState = timelineDragStateRef.current;
        if (!dragState) {
          return;
        }

        // Dragging upward increases timeline height; dragging downward decreases it.
        const deltaY = dragState.startY - moveEvent.clientY;
        setTimelineHeight(clampTimelineHeight(dragState.startHeight + deltaY));
      };

      const handleMouseUp = () => {
        timelineDragStateRef.current = null;
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [clampTimelineHeight, timelineHeight],
  );

  const handleSidebarResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();

      sidebarDragStateRef.current = {
        startX: event.clientX,
        startWidth: sidebarWidth,
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const dragState = sidebarDragStateRef.current;
        if (!dragState) {
          return;
        }

        // Dragging left makes the sidebar wider; dragging right makes it narrower.
        const deltaX = dragState.startX - moveEvent.clientX;
        setSidebarWidth(clampSidebarWidth(dragState.startWidth + deltaX));
      };

      const handleMouseUp = () => {
        sidebarDragStateRef.current = null;
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [clampSidebarWidth, sidebarWidth],
  );

  useEffect(() => {
    setTimelineHeight((current) => clampTimelineHeight(current));
  }, [clampTimelineHeight]);

  useEffect(() => {
    setSidebarWidth((current) => clampSidebarWidth(current));
  }, [clampSidebarWidth]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleResize = () => {
      setTimelineHeight((current) => clampTimelineHeight(current));
      setSidebarWidth((current) => clampSidebarWidth(current));
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [clampSidebarWidth, clampTimelineHeight]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(TIMELINE_HEIGHT_STORAGE_KEY, String(timelineHeight));
  }, [timelineHeight]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  return (
    <div ref={rootRef} className="flex flex-col h-full bg-background text-foreground">
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 flex items-center justify-center bg-background/50 relative">
          {viewport}
        </div>

        <div
          className="group w-3 shrink-0 border-x border-border bg-card/70 hover:bg-card cursor-col-resize flex items-center justify-center"
          onMouseDown={handleSidebarResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize properties panel"
        >
          <div className="w-1 h-14 rounded-full bg-muted-foreground/40 transition-colors group-hover:bg-muted-foreground/70" />
        </div>

        <div style={{ width: sidebarWidth }} className="shrink-0 bg-sidebar overflow-y-auto">
          {properties}
        </div>
      </div>

      <div
        className="group h-3 border-t border-border bg-card/70 hover:bg-card cursor-row-resize flex items-center justify-center"
        onMouseDown={handleTimelineResizeStart}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline"
      >
        <div className="h-1 w-14 rounded-full bg-muted-foreground/40 transition-colors group-hover:bg-muted-foreground/70" />
      </div>

      <div style={{ height: timelineHeight }} className="min-h-52 bg-card border-t border-border">
        {timeline}
      </div>
    </div>
  );
}
