/**
 * Where a Linux recording's clicks come from, for auto zoom.
 *
 * - Hyprland reports every click through binds (`hyprland-clicks.ts`).
 * - Other Wayland desktops (GNOME, KDE) give an app no global clicks, so
 *   velocity reads the mice and touchpads themselves (evdev). That needs the
 *   user in the `input` group; without it the recorder says how to join.
 * - An X11 session has the uiohook hook, as on Windows.
 */

export type LinuxClickSource = 'hyprland' | 'evdev' | 'x11';

export function linuxClickSource(env: Record<string, string | undefined>): LinuxClickSource {
  if (env.HYPRLAND_INSTANCE_SIGNATURE) return 'hyprland';
  if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) return 'evdev';
  return 'x11';
}

/** The command that lets recso read mouse clicks. */
export const INPUT_GROUP_COMMAND = 'sudo usermod -aG input $USER';

/**
 * What to tell the user when auto zoom can't see their clicks, or null when
 * it can (or the desktop doesn't need evdev).
 */
export function clickAccessHint(
  source: LinuxClickSource,
  access: { devices: number; readable: number } | null,
): string | null {
  if (source !== 'evdev' || !access || access.devices === 0 || access.readable > 0) return null;
  return `Auto zoom can't see your clicks on this desktop. To let it, run \`${INPUT_GROUP_COMMAND}\` in a terminal, then log out and back in.`;
}
