/**
 * Editor Screen — Main entry point for the video editor.
 *
 * Receives recordingId and initializes the EditorProvider.
 * Composes the layout with Viewport, Properties, and Timeline.
 */

import { PropertiesPanel } from './properties/properties-panel';
import { TimelineContainer } from './timeline/timeline-container';
import { PreviewCanvas } from './viewport/preview-canvas';
import { EditorProvider, useEditor } from '../../../context/editor-context';
import { EditorLayout } from './editor-layout';

interface EditorScreenProps {
  recordingId: string;
}

function EditorContent() {
  const { project, isLoading, error } = useEditor();

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <div className="w-10 h-10 border-4 border-muted border-t-primary rounded-full animate-spin mb-4" />
        <p>Loading project...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <h2 className="text-destructive mb-2 font-bold text-xl">Error Loading Project</h2>
        <p>{error}</p>
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
      viewport={<PreviewCanvas />}
      properties={<PropertiesPanel />}
      timeline={<TimelineContainer />}
    />
  );
}

export function EditorScreen({ recordingId }: EditorScreenProps) {
  return (
    <EditorProvider recordingId={recordingId}>
      <div className="w-full h-screen bg-background text-foreground flex flex-col overflow-hidden">
        <EditorContent />
      </div>
    </EditorProvider>
  );
}

export default EditorScreen;
