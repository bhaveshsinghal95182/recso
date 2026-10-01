// First: `recso --cli …` runs recso-cli and exits before the app starts.
import './cli-handoff.js';

import { app, BrowserWindow, ipcMain, screen } from 'electron';

// APPX/MSIX Store apps launch with cwd = C:\WINDOWS\system32 (read-only).
// Redirect to writable userData folder before anything else runs.
if (app.isPackaged) {
  process.chdir(app.getPath('userData'));
}

import path from 'path';

import { initializeAutomation, isAutomationRunning } from './automation/index.js';
import { initializeWithWindow, registerAllIpcHandlers } from './ipc/index.js';
import { integrateAppImage } from './services/appimage-integration.js';
import { initializeDatabase } from './services/database.service.js';
import { checkGpuMatch } from './services/engine/gpu.service.js';
import { initializeTelemetry } from './services/telemetry/telemetry.service.js';
import { createTray } from './services/tray.service.js';
import { startAutoUpdates } from './services/updater.service.js';
import { initializeLogging } from './utils/logger.js';
import { getAppIconPath, getPreloadPath } from './path-resolver.js';
import { isDevelopment } from './util.js';
import { createMainWindowWebPreferences } from './window-security.js';

// One app per user: a second launch hands over to the first (which shows its
// window, see 'second-instance' below) and exits. A headless export is the
// exception; the Automation API runs its export jobs as separate processes.
const isHeadlessExport = process.argv.includes('--export-project');
if (!isHeadlessExport && !app.requestSingleInstanceLock()) {
  app.exit(0);
}

// Shared textures cannot cross adapters. The engine builds its D3D11 device on
// the high-performance GPU, so Chromium's GPU process has to be there too, or
// every importSharedTexture is handed a handle from a device it cannot open.
//
// Must be set before the app is ready; afterwards the GPU process is already
// up. Harmless when the engine is absent -- Chromium just prefers the discrete
// GPU, which is what a recorder and video editor want anyway.
if (process.env.RECSO_ENGINE_GPU !== 'integrated') {
  app.commandLine.appendSwitch('force_high_performance_gpu');
}

app.on('ready', () => {
  const exportProjectFlag = process.argv.indexOf('--export-project');
  const exportProjectSync = process.argv.includes('--export-project-sync');
  const exportProjectDumpRender = process.argv.includes('--export-project-dump-render');
  if (exportProjectSync) {
    process.env.RECSO_ENGINE_SYNC_GPU = '1';
  }
  const exportProjectArgument =
    exportProjectFlag >= 0
      ? process.argv
          .slice(exportProjectFlag + 1)
          .find((argument) => !argument.startsWith('--'))
          ?.trim()
      : undefined;
  const headlessExportProject = exportProjectArgument
    ? path.resolve(exportProjectArgument)
    : undefined;
  // Set by the Automation API when it runs an export in this process.
  const flagValue = (flag: string) => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const headlessExportQuery: Record<string, string> = {};
  for (const [flag, key] of [
    ['--export-output', 'exportOutput'],
    ['--export-preset', 'exportPreset'],
    ['--export-encoder', 'exportEncoder'],
  ] as const) {
    const value = flagValue(flag);
    if (value) headlessExportQuery[key] = value;
  }
  // Machine-readable lines for the API's export jobs, next to the log.
  const exportProtocol = process.env.RECSO_EXPORT_PROTOCOL === '1';
  const emitExportMessage = (message: Record<string, unknown>) => {
    if (exportProtocol) process.stdout.write(`@@recso-export ${JSON.stringify(message)}\n`);
  };
  // Started by `recso-cli --launch`: serve the API without taking the screen.
  const startInBackground = process.argv.includes('--background');
  if (exportProjectDumpRender && headlessExportProject) {
    process.env.RECSO_ENGINE_DUMP_RENDER_DIR = path.join(
      headlessExportProject,
      '.recso',
      'render-dump',
    );
  }
  initializeLogging({ mirrorConsole: isDevelopment() || exportProjectFlag >= 0 });

  // Initialize database first (for crash-safe recording metadata)
  initializeDatabase();

  // Initialize telemetry (support ID + error handlers)
  initializeTelemetry();

  // Register all IPC handlers before creating window
  registerAllIpcHandlers();

  if (exportProjectFlag >= 0 && !headlessExportProject) {
    console.error('Usage: pnpm export:project "C:\\path\\to\\project-folder"');
    app.exit(2);
    return;
  }

  if (headlessExportProject) {
    ipcMain.on('headless-export:log', (_event, message: string) => {
      console.log(`[ProjectExport] ${message}`);
    });
    ipcMain.on('headless-export:progress', (_event, progress: Record<string, unknown>) => {
      emitExportMessage({ type: 'progress', ...progress });
    });
    ipcMain.once(
      'headless-export:complete',
      (_event, result: { ok: boolean; outputPath?: string; error?: string }) => {
        if (result.ok) {
          console.log(`[ProjectExport] Complete: ${result.outputPath ?? 'unknown output'}`);
          emitExportMessage({ type: 'complete', outputPath: result.outputPath ?? null });
          app.exit(0);
        } else {
          console.error(`[ProjectExport] Failed: ${result.error ?? 'unknown error'}`);
          emitExportMessage({ type: 'failed', error: result.error ?? 'unknown error' });
          app.exit(1);
        }
      },
    );
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const mainWindow = new BrowserWindow({
    width,
    height,
    webPreferences: {
      ...createMainWindowWebPreferences(
        headlessExportProject
          ? path.join(app.getAppPath(), 'dist-electron', 'preload.cjs')
          : getPreloadPath(),
        { development: isDevelopment() && !headlessExportProject },
      ),
      backgroundThrottling: !headlessExportProject,
    },
    frame: false,
    // Windows and macOS take the icon from the executable or bundle.
    icon: process.platform === 'linux' ? getAppIconPath() : undefined,
    show: !headlessExportProject && !startInBackground,
  });

  if (startInBackground && !headlessExportProject) {
    // Maximising would show it; wait until something (app.show) does.
    mainWindow.once('show', () => mainWindow.maximize());
  } else if (!headlessExportProject) {
    mainWindow.maximize();
  }

  if (headlessExportProject) {
    console.log(`[ProjectExport] Starting hidden renderer for ${headlessExportProject}`);
    mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`[ProjectExport] Preload failed: ${preloadPath}`, error);
      app.exit(1);
    });
    const startupTimer = setTimeout(() => {
      console.error('[ProjectExport] Renderer did not start within 30 seconds');
      app.exit(1);
    }, 30_000);
    ipcMain.once('headless-export:log', () => clearTimeout(startupTimer));
  }

  if (isDevelopment() && !headlessExportProject) {
    const url = new URL('http://localhost:5123');
    if (headlessExportProject) {
      url.searchParams.set('headlessExportProject', headlessExportProject);
    }
    mainWindow.loadURL(url.toString());
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist-react/index.html'), {
      query: headlessExportProject ? { headlessExportProject, ...headlessExportQuery } : undefined,
    });
  }

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Main] Renderer process gone:', details);
    if (headlessExportProject) app.exit(1);
  });

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error('[Main] Renderer failed to load:', {
        errorCode,
        errorDescription,
        validatedURL,
      });
      if (headlessExportProject) app.exit(1);
    },
  );

  mainWindow.webContents.on('unresponsive', () => {
    console.error('[Main] Renderer became unresponsive');
  });

  // Initialize IPC with window reference and start polling
  initializeWithWindow(mainWindow);

  // Create system tray
  if (!headlessExportProject) {
    app.on('second-instance', (_event, argv) => {
      // recso-cli --launch only needs the API, which is already up.
      if (argv.includes('--background')) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    createTray(mainWindow);
    if (process.platform === 'linux') {
      try {
        const result = integrateAppImage({ env: process.env, home: app.getPath('home') });
        if (result !== 'not-an-appimage') console.log(`[Main] AppImage menu entry: ${result}`);
      } catch (error) {
        console.error('[Main] Could not add the AppImage to the app menu:', error);
      }
    }
    startAutoUpdates();
    // Off unless the user turned it on; a headless export never serves it.
    void initializeAutomation(mainWindow).then(() => {
      // Started hidden for recso-cli --launch, but with the API off (or failing
      // to start) nothing could ever show it.
      if (startInBackground && !isAutomationRunning()) mainWindow.show();
    });
  }

  // Fire-and-forget: reports which adapter the engine and Chromium each landed
  // on, and warns if they diverge. Only meaningful once the GPU process is up.
  void checkGpuMatch();
});
