import { EditorProvider } from '../../context/editor-context';
import { EditorContent } from './content';

interface EditorScreenProps {
  recordingId: string;
}

export function EditorScreen({ recordingId }: EditorScreenProps) {
  return (
    <EditorProvider recordingId={recordingId}>
      <div className="w-full h-screen bg-background overflow-hidden">
        <EditorContent />
      </div>
    </EditorProvider>
  );
}

export default EditorScreen;
