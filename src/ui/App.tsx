import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ExportProgressToast } from '@/components/export-progress-toast';
import { Toaster } from '@/components/ui/sonner';
import { RootLayout } from '@/layouts/root-layout';
import { parseExportPreset } from '@/lib/export-preset';
import { EditorScreen } from '@/screens/editor';
import { planExport, runNativeExport } from '@/screens/editor/engine/export-pipeline';
import { EngineHarnessScreen } from '@/screens/engine-harness';
import ScreenRecorder from '@/screens/screen-recorder';
import { WelcomeScreen } from '@/screens/welcome/welcome-screen';
import type { ExportConfig, ExportProgress } from '@/types';

type Screen = 'welcome' | 'recorder' | 'editor' | 'engine';

/**
 * The GPU engine harness is a dev tool, not a feature. It is reachable by
 * loading the app with `#engine`, and only in a dev build -- a production
 * bundle has no route to it at all.
 */
function initialScreen(): Screen {
  if (!import.meta.env.DEV) {
    return 'welcome';
  }
  // VITE_ENGINE_AUTORUN implies the harness -- the check it runs is the whole
  // reason the process was started.
  if (window.location.hash === '#engine' || import.meta.env.VITE_ENGINE_AUTORUN) {
    return 'engine';
  }
  return 'welcome';
}

interface AppState {
  screen: Screen;
  recordingId: string | null;
}

/** What `--export-output`, `--export-preset` and `--export-encoder` asked for. */
export interface HeadlessExportRequest {
  output?: string;
  preset?: string;
  encoder?: 'auto' | 'hardware' | 'software';
}

function headlessExportRequest(params: URLSearchParams): HeadlessExportRequest {
  const encoder = params.get('exportEncoder');
  return {
    output: params.get('exportOutput') ?? undefined,
    preset: params.get('exportPreset') ?? undefined,
    encoder:
      encoder === 'auto' || encoder === 'hardware' || encoder === 'software' ? encoder : undefined,
  };
}

function HeadlessProjectExport({
  projectFolder,
  request,
}: {
  projectFolder: string;
  request: HeadlessExportRequest;
}) {
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      try {
        window.electron.headlessExport.log(`Loading project folder: ${projectFolder}`);
        const project = await window.electron.editor.loadProject(projectFolder);
        if (!project) {
          throw new Error(`No valid .recso/project.json found under ${projectFolder}`);
        }

        window.electron.headlessExport.log(
          `Loaded project "${project.name}" (${project.recordingId})`,
        );

        const mouseEvents = (await window.electron.editor.getMouseEvents()) ?? [];
        window.electron.headlessExport.log(`Loaded ${mouseEvents.length} cursor/mouse events`);
        window.electron.headlessExport.log(
          `Timeline: ${project.timeline.duration.toFixed(0)}ms, ${project.cuts.length} cuts, ` +
            `${project.zoomRegionsBySource?.screen?.length ?? project.zoomRegions.length} screen zooms, ` +
            `${project.zoomRegionsBySource?.webcam?.length ?? 0} webcam zooms`,
        );

        const [resolution, quality] = parseExportPreset(request.preset);
        const config: ExportConfig = {
          resolution,
          format: 'mp4',
          quality,
          backgroundColor: project.backgroundColor || '#000000',
          glRenderer: 'angle',
        };
        const outputPath =
          request.output ?? (await window.electron.exporter.resolveOutputPath(config));
        if (!outputPath) {
          throw new Error('Unable to resolve an output path for the loaded project');
        }
        window.electron.headlessExport.log(`Output: ${outputPath}`);
        window.electron.headlessExport.log(
          `Settings: ${config.resolution}, ${config.quality} quality, ${config.format.toUpperCase()}`,
        );

        const shared = {
          project,
          config,
          screenZoomRegions: project.zoomRegionsBySource?.screen ?? project.zoomRegions ?? [],
          webcamZoomRegions: project.zoomRegionsBySource?.webcam ?? [],
          mouseEvents,
          onProgress: (progress: ExportProgress) => {
            window.electron.headlessExport.progress({
              percent: progress.percent,
              fps: progress.fps,
              eta: progress.eta,
              phase: progress.phase,
              encoder: progress.encoder ?? null,
            });
            if (progress.currentFrame % 120 === 0 || progress.percent >= 100) {
              window.electron.headlessExport.log(
                `${progress.percent.toFixed(1)}% (${progress.currentFrame}/${progress.totalFrames} frames, ` +
                  `${progress.fps.toFixed(1)} fps, ETA ${progress.eta.toFixed(1)}s)`,
              );
            }
          },
        };

        window.electron.headlessExport.log('Resolving saved composition and media assets');
        const plan = await planExport(shared);
        window.electron.headlessExport.log(
          `Composition: ${plan.output.width}x${plan.output.height}, ` +
            `${plan.compositionDurationMs.toFixed(0)}ms, webcam=${Boolean(plan.webcamSourcePath)}`,
        );
        window.electron.headlessExport.log('Starting native export');
        const result = await runNativeExport({
          ...shared,
          plan,
          outputPath,
          encoder: request.encoder,
        });
        window.electron.headlessExport.complete({ ok: true, outputPath: result.outputPath });
      } catch (error) {
        window.electron.headlessExport.complete({
          ok: false,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      }
    })();
  }, [projectFolder]);

  return null;
}

function InteractiveApp() {
  const [state, setState] = useState<AppState>({
    screen: initialScreen(),
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

  // The Automation API moves the window: to the recorder when an API recording
  // starts (never record behind another screen), to the editor for
  // `projects.open`. Asked for on mount too, since a request can come first.
  const openRecentProjectRef = useRef<(path: string) => Promise<void>>(async () => undefined);
  useEffect(() => {
    const follow = async () => {
      const navigation = await window.electron.automation.takeNavigation();
      if (navigation?.screen === 'recorder') {
        setState((current) =>
          current.screen === 'recorder' ? current : { screen: 'recorder', recordingId: null },
        );
      } else if (navigation?.screen === 'editor') {
        await openRecentProjectRef.current(navigation.projectDir);
      }
    };
    const unsubscribe = window.electron.automation.onNavigate(() => void follow());
    void follow();
    return unsubscribe;
  }, []);

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
  useEffect(() => {
    openRecentProjectRef.current = handleOpenRecentProject;
  });

  switch (state.screen) {
    case 'engine':
      return (
        <RootLayout>
          <button
            onClick={goHome}
            className="fixed top-12 left-2 z-1000 bg-black/50 hover:bg-black/70 text-white border-0 rounded px-3 py-1.5 cursor-pointer text-xs backdrop-blur-sm transition-colors"
          >
            ← Home
          </button>
          <div className="pt-20">
            <EngineHarnessScreen />
          </div>
          <Toaster />
        </RootLayout>
      );

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

function App() {
  const headlessExportProject = new URLSearchParams(window.location.search).get(
    'headlessExportProject',
  );

  return headlessExportProject ? (
    <HeadlessProjectExport
      projectFolder={headlessExportProject}
      request={headlessExportRequest(new URLSearchParams(window.location.search))}
    />
  ) : (
    <InteractiveApp />
  );
}

export default App;
