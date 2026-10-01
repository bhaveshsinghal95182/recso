import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { desktopEntry, integrateAppImage, quoteExecArgument } from './appimage-integration.js';

const roots: string[] = [];

/** A home directory and a mounted AppImage with one icon size. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'recso-appimage-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const appDir = path.join(root, 'mount');
  const icons = path.join(appDir, 'usr/share/icons/hicolor/256x256/apps');
  mkdirSync(icons, { recursive: true });
  writeFileSync(path.join(icons, 'recso.png'), 'png');
  mkdirSync(home);
  const applications = path.join(home, '.local/share/applications');
  return { home, appDir, applications, entry: path.join(applications, 'recso.desktop') };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('quoteExecArgument', () => {
  it('leaves a plain path alone', () => {
    expect(quoteExecArgument('/home/a/recso.AppImage')).toBe('/home/a/recso.AppImage');
  });

  it('quotes spaces and escapes what the spec reserves inside quotes', () => {
    expect(quoteExecArgument('/home/a/My Apps/re$c"o.AppImage')).toBe(
      '"/home/a/My Apps/re\\\\$c\\\\"o.AppImage"',
    );
  });

  it('doubles a percent sign, which would otherwise be a field code', () => {
    expect(quoteExecArgument('/apps/100%/recso.AppImage')).toBe('/apps/100%%/recso.AppImage');
  });
});

describe('desktopEntry', () => {
  it('launches the AppImage and matches the window by its class', () => {
    const entry = desktopEntry('/apps/recso.AppImage');
    expect(entry).toContain('Exec=/apps/recso.AppImage --no-sandbox %U\n');
    expect(entry).toContain('Icon=recso\n');
    expect(entry).toContain('StartupWMClass=recso\n');
    expect(entry).toContain('X-Recso-AppImage=true\n');
  });
});

describe('integrateAppImage', () => {
  it('does nothing outside an AppImage', () => {
    const { home, entry } = fixture();
    expect(integrateAppImage({ env: {}, home })).toBe('not-an-appimage');
    expect(() => readFileSync(entry)).toThrow();
  });

  it('writes the menu entry and installs the icons', () => {
    const { home, appDir, entry } = fixture();
    const env = { APPIMAGE: '/apps/recso.AppImage', APPDIR: appDir };
    expect(integrateAppImage({ env, home })).toBe('written');
    expect(readFileSync(entry, 'utf8')).toBe(desktopEntry('/apps/recso.AppImage'));
    expect(
      readFileSync(path.join(home, '.local/share/icons/hicolor/256x256/apps/recso.png'), 'utf8'),
    ).toBe('png');
  });

  it('leaves an up-to-date entry alone, and follows the AppImage when it moves', () => {
    const { home, appDir, entry } = fixture();
    integrateAppImage({ env: { APPIMAGE: '/apps/recso.AppImage', APPDIR: appDir }, home });
    expect(
      integrateAppImage({ env: { APPIMAGE: '/apps/recso.AppImage', APPDIR: appDir }, home }),
    ).toBe('current');
    expect(
      integrateAppImage({ env: { APPIMAGE: '/moved/recso.AppImage', APPDIR: appDir }, home }),
    ).toBe('written');
    expect(readFileSync(entry, 'utf8')).toContain('Exec=/moved/recso.AppImage ');
  });

  it('never replaces an entry it did not write', () => {
    const { home, appDir, applications, entry } = fixture();
    mkdirSync(applications, { recursive: true });
    writeFileSync(entry, '[Desktop Entry]\nExec=/opt/recso/recso\n');
    const env = { APPIMAGE: '/apps/recso.AppImage', APPDIR: appDir };
    expect(integrateAppImage({ env, home })).toBe('foreign-entry');
    expect(readFileSync(entry, 'utf8')).toBe('[Desktop Entry]\nExec=/opt/recso/recso\n');
  });

  it('stays out of the way of an AppImage manager that already added it', () => {
    const { home, appDir, applications, entry } = fixture();
    mkdirSync(applications, { recursive: true });
    writeFileSync(
      path.join(applications, 'appimagekit_1234-recso.desktop'),
      '[Desktop Entry]\nExec=/apps/recso.AppImage %U\n',
    );
    const env = { APPIMAGE: '/apps/recso.AppImage', APPDIR: appDir };
    expect(integrateAppImage({ env, home })).toBe('managed-elsewhere');
    expect(() => readFileSync(entry)).toThrow();
  });
});
