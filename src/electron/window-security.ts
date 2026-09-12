import type { WebPreferences } from 'electron';

export interface MainWindowSecurityOptions {
  /** Development still loads local project assets from the Vite HTTP origin. */
  development?: boolean;
}

/** Security-sensitive BrowserWindow preferences live here so they stay testable. */
export function createMainWindowWebPreferences(
  preload: string,
  options: MainWindowSecurityOptions = {},
): WebPreferences {
  return {
    preload,
    // Electron omits `sharedTexture` from its sandboxed preload API. This
    // window owns the GPU preview receiver, so sandboxing it would silently
    // replace the native render path with Canvas2D.
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false,
    // The Vite origin cannot load local recording/background URLs. Packaged
    // builds use a file origin and keep Chromium's web security enabled.
    webSecurity: options.development !== true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  };
}
