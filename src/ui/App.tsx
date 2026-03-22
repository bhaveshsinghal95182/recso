import { useState } from 'react';
import { toast } from 'sonner';

import { ExportProgressToast } from '@/components/export-progress-toast';
import { Toaster } from '@/components/ui/sonner';
import { RootLayout } from '@/layouts/root-layout';
import { EditorScreen } from '@/screens/editor';
import ScreenRecorder from '@/screens/screen-recorder';
import { WelcomeScreen } from '@/screens/welcome/welcome-screen';

type Screen = 'welcome' | 'recorder' | 'editor';

interface AppState {
  screen: Screen;
  recordingId: string | null;
}

function App() {
  const [state, setState] = useState<AppState>({
    screen: 'welcome',
    recordingId: null,
  });

  // Navigate to editor with a recording
  const openEditor = (recordingId: string) => {
    setState({ screen: 'editor', recordingId });
  };

  // Navigate back to welcome screen
  const goHome = () => {
    setState({ screen: 'welcome', recordingId: null });
  };

  // Go to recorder
  const goToRecorder = () => {
    setState({ screen: 'recorder', recordingId: null });
  };

  // Handle opening an existing project
  const handleOpenProject = async () => {
    try {
      // 1. Open directory picker
      const path = await window.electron.recorder.showOpenDialog();
      if (!path) return; // User cancelled

      // 2. Load project (this returns the project object)
      const project = await window.electron.editor.loadProject(path);

      if (project) {
        // 3. Navigate to editor
        setState({ screen: 'editor', recordingId: project.recordingId });
      } else {
        // TODO: Show error toast?
        console.error('Failed to load project at:', path);
      }
    } catch (error) {
      console.error('Error opening project:', error);
    }
  };

  // Handle opening a recent project bypasses the file dialog
  const handleOpenRecentProject = async (path: string) => {
    try {
      const project = await window.electron.editor.loadProject(path);
      if (project) {
        setState({ screen: 'editor', recordingId: project.recordingId });
      } else {
        toast.error('Project not found', {
          description: 'The folder might have been moved or deleted.',
        });
      }
    } catch (error) {
      console.error('Error opening recent project:', error);
      toast.error('Failed to open project');
    }
  };

  switch (state.screen) {
    case 'welcome':
      return (
        <RootLayout>
          <WelcomeScreen
            onNewRecording={goToRecorder}
            onOpenProject={handleOpenProject}
            onOpenRecentProject={handleOpenRecentProject}
          />
          <Toaster />
          <ExportProgressToast />
        </RootLayout>
      );

    case 'editor':
      if (!state.recordingId) {
        // Fallback if no recordingId
        return (
          <RootLayout>
            <WelcomeScreen
              onNewRecording={goToRecorder}
              onOpenProject={handleOpenProject}
              onOpenRecentProject={handleOpenRecentProject}
            />
            <Toaster />
            <ExportProgressToast />
          </RootLayout>
        );
      }
      return (
        <RootLayout>
          {/* Back button overlay */}
          <button
            onClick={goHome}
            className="fixed top-12 left-2 z-1000 bg-black/50 hover:bg-black/70 text-white border-0 rounded px-3 py-1.5 cursor-pointer text-xs backdrop-blur-sm transition-colors"
          >
            ← Home
          </button>
          <EditorScreen recordingId={state.recordingId} />
          <Toaster />
          <ExportProgressToast />
        </RootLayout>
      );

    case 'recorder':
    default:
      return (
        <RootLayout>
          <button
            onClick={goHome}
            className="fixed top-12 left-2 z-1000 bg-black/50 hover:bg-black/70 text-white border-0 rounded px-3 py-1.5 cursor-pointer text-xs backdrop-blur-sm transition-colors"
          >
            ← Home
          </button>
          <ScreenRecorder onOpenEditor={openEditor} />
          <Toaster />
          <ExportProgressToast />
        </RootLayout>
      );
  }
}

export default App;
