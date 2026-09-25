import { describe, expect, it } from 'vitest';

import { createMainWindowWebPreferences } from './window-security.js';

describe('createMainWindowWebPreferences', () => {
  it('keeps shared-texture preview available without exposing Node to the page', () => {
    const preferences = createMainWindowWebPreferences('C:\\recso\\preload.cjs');

    expect(preferences).toMatchObject({
      preload: 'C:\\recso\\preload.cjs',
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
  });

  it('only relaxes web security for the Vite development origin', () => {
    const preferences = createMainWindowWebPreferences('C:\\recso\\preload.cjs', {
      development: true,
    });

    expect(preferences).toMatchObject({
      sandbox: false,
      webSecurity: false,
      contextIsolation: true,
      nodeIntegration: false,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
  });
});
