import { useEffect } from 'react';

import { useProjectStore } from '@/store/project-store';

import { EditorContent } from './content';

interface EditorScreenProps {
  recordingId: string;
}

export function EditorScreen({ recordingId }: EditorScreenProps) {
  const { loadProject, closeProject } = useProjectStore();

  useEffect(() => {
    if (recordingId) {
      loadProject(recordingId);
    }
    return () => {
      closeProject();
    };
  }, [recordingId, loadProject, closeProject]);

  return (
    <div className="w-full h-screen bg-background overflow-hidden">
      <EditorContent />
    </div>
  );
}

export default EditorScreen;
