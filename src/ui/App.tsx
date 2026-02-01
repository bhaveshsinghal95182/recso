import { useState } from 'react';

import { RootLayout } from './components/layouts/root-layout';
import { EditorScreen } from './components/screens/editor';
import ScreenRecorder from './components/screens/screen-recorder';
import { WelcomeScreen } from './components/screens/welcome/welcome-screen';

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

  switch (state.screen) {
    case 'welcome':
      return (
        <RootLayout>
          <WelcomeScreen onNewRecording={goToRecorder} onOpenProject={handleOpenProject} />
        </RootLayout>
      );

    case 'editor':
      if (!state.recordingId) {
        // Fallback if no recordingId
        return (
          <RootLayout>
            <WelcomeScreen onNewRecording={goToRecorder} onOpenProject={handleOpenProject} />
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
        </RootLayout>
      );

    case 'recorder':
    default:
      return (
        <RootLayout>
          <ScreenRecorder onOpenEditor={openEditor} />
        </RootLayout>
      );
  }
}

export default App;
