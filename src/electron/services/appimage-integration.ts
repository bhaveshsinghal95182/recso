/**
 * Puts a running AppImage in the desktop's app menu.
 *
 * An AppImage is one file that runs where it lies, so nothing tells the
 * desktop it exists: it has no menu entry, and on Wayland a window is matched
 * to its icon through the `.desktop` file named after its app id, so the
 * window shows a generic icon too. On each launch this writes
 * `~/.local/share/applications/recso.desktop` pointing at the AppImage, and
 * copies its icons into the user's hicolor theme.
 *
 * It leaves alone an entry it did not write (a hand-made one, or the deb's
 * user override), and an AppImage that a manager such as AppImageLauncher or
 * Gear Lever has already added under its own file name.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Marks an entry this module wrote, and may therefore rewrite. */
const MARKER = 'X-Recso-AppImage=true';

export type IntegrationResult =
  | 'not-an-appimage'
  | 'written'
  | 'current'
  | 'foreign-entry'
  | 'managed-elsewhere';

/**
 * One `Exec` argument, quoted per the Desktop Entry spec: inside double
 * quotes, `"`, `` ` ``, `$` and `\` take a backslash, and that backslash is
 * itself escaped because the value is also a string. `%` is doubled outside
 * and inside quotes so it is not read as a field code.
 */
export function quoteExecArgument(argument: string): string {
  const percent = argument.replaceAll('%', '%%');
  if (!/[\s"'`$\\<>~|&;*?#()]/.test(percent)) return percent;
  return `"${percent.replace(/(["`$\\])/g, '\\\\$1')}"`;
}

export function desktopEntry(appImage: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Recso',
    'Comment=Record your screen and edit the video',
    // As in the entry electron-builder puts inside the AppImage: Chromium's
    // setuid sandbox helper can't be setuid inside a read-only mount.
    `Exec=${quoteExecArgument(appImage)} --no-sandbox %U`,
    'Icon=recso',
    'StartupWMClass=recso',
    'Terminal=false',
    'Categories=AudioVideo;Recorder;',
    MARKER,
    '',
  ].join('\n');
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Another entry in the menu already launches this very file. */
function managedElsewhere(applications: string, appImage: string, own: string): boolean {
  let names: string[];
  try {
    names = readdirSync(applications);
  } catch {
    return false;
  }
  return names.some((name) => {
    if (!name.endsWith('.desktop') || path.join(applications, name) === own) return false;
    const text = readText(path.join(applications, name));
    return (
      !!text && text.split('\n').some((line) => line.startsWith('Exec=') && line.includes(appImage))
    );
  });
}

/** Copy `usr/share/icons/hicolor/<size>/apps/recso.png` from the mounted image. */
function installIcons(appDir: string, home: string): void {
  const source = path.join(appDir, 'usr/share/icons/hicolor');
  let sizes: string[];
  try {
    sizes = readdirSync(source);
  } catch {
    return;
  }
  for (const size of sizes) {
    const icon = path.join(source, size, 'apps', 'recso.png');
    if (!existsSync(icon)) continue;
    const target = path.join(home, '.local/share/icons/hicolor', size, 'apps');
    mkdirSync(target, { recursive: true });
    copyFileSync(icon, path.join(target, 'recso.png'));
  }
}

export function integrateAppImage({
  env,
  home,
}: {
  env: Record<string, string | undefined>;
  home: string;
}): IntegrationResult {
  const appImage = env.APPIMAGE;
  if (!appImage) return 'not-an-appimage';
  const applications = path.join(home, '.local/share/applications');
  const own = path.join(applications, 'recso.desktop');
  const existing = readText(own);
  if (existing !== null && !existing.includes(MARKER)) return 'foreign-entry';
  if (existing === null && managedElsewhere(applications, appImage, own)) {
    return 'managed-elsewhere';
  }
  const entry = desktopEntry(appImage);
  if (existing === entry) return 'current';
  if (env.APPDIR) installIcons(env.APPDIR, home);
  mkdirSync(applications, { recursive: true });
  writeFileSync(own, entry);
  return 'written';
}
