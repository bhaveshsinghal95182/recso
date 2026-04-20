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

import type { ReactNode } from 'react';

interface EditorLayoutProps {
  viewport: ReactNode;
  properties: ReactNode;
  timeline: ReactNode;
}

export function EditorLayout({ viewport, properties, timeline }: EditorLayoutProps) {
  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 flex items-center justify-center bg-background/50 border-r border-border relative">
          {viewport}
        </div>
        <div className="w-70 bg-sidebar border-l border-border overflow-y-auto">{properties}</div>
      </div>
      <div className="h-[34vh] min-h-52 max-h-96 bg-card border-t border-border">{timeline}</div>
    </div>
  );
}
