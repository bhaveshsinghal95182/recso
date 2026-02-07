import { useEditor } from '../../../context/editor-context';
import { EditorLayout } from './editor-layout';
import { MinimalPreview } from './preview';
import { PropertiesPanel } from './properties-panel';
import { Timeline } from './timeline';

export function EditorContent() {
  const { project, isLoading, error } = useEditor();

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
