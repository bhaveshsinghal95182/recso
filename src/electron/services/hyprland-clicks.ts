/** Capture mouse presses from Hyprland's Lua binds when native hooks cannot see Wayland clicks. */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';

export type ClickButton = 'left' | 'right' | 'middle';

export interface HyprlandClick {
  button: ClickButton;
  /** Wall-clock time of the press, ms since the Unix epoch. */
  atEpochMs: number;
  /** Physical pixels in Hyprland's global layout (logical position × the scale of the monitor it is on). */
  x: number;
  y: number;
}

export interface MonitorLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
} // width/height LOGICAL (pixel size / scale)

const BUTTON_KEYS: Record<ClickButton, string> = {
  left: 'mouse:272',
  right: 'mouse:273',
  middle: 'mouse:274',
};
const BUTTONS: ClickButton[] = ['left', 'right', 'middle'];
/** Marks the binds as recso's, in `hyprctl binds` and for cleanup. */
const BIND_DESCRIPTION = 'recso click capture';

/** Hyprland reports pixel dimensions, while cursor positions use logical monitor bounds. */
export function parseMonitors(value: unknown): MonitorLayout[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry: unknown): MonitorLayout[] => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const monitor = entry as Record<string, unknown>;
    const { x, y, width, height, scale } = monitor;
    if (
      typeof scale !== 'number' ||
      !Number.isFinite(scale) ||
      scale <= 0 ||
      typeof x !== 'number' ||
      !Number.isFinite(x) ||
      typeof y !== 'number' ||
      !Number.isFinite(y) ||
      typeof width !== 'number' ||
      !Number.isFinite(width) ||
      typeof height !== 'number' ||
      !Number.isFinite(height)
    ) {
      return [];
    }
    return [{ x, y, width: width / scale, height: height / scale, scale }];
  });
}

/** Match velocity's monitor choice, including its first-monitor fallback between displays. */
export function toPhysical(
  x: number,
  y: number,
  monitors: MonitorLayout[],
): { x: number; y: number } {
  const monitor =
    monitors.find(
      (candidate) =>
        x >= candidate.x &&
        x < candidate.x + candidate.width &&
        y >= candidate.y &&
        y < candidate.y + candidate.height,
    ) ?? monitors[0];
  const scale = monitor?.scale ?? 1;
  return { x: x * scale, y: y * scale };
}

/** The header distinguishes an empty drain from an unrelated or failed REPL reply. */
export function parseDrainReply(
  reply: string,
): Array<{ button: ClickButton; uptimeSec: number; x: number; y: number }> {
  const [header, ...lines] = reply.trimStart().split(/\r?\n/);
  if (header !== 'clicks') {
    return [];
  }

  const clicks: Array<{ button: ClickButton; uptimeSec: number; x: number; y: number }> = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) {
      continue;
    }
    const [button, uptimeText, xText, yText] = parts;
    if (button !== 'left' && button !== 'right' && button !== 'middle') {
      continue;
    }
    const uptimeSec = Number(uptimeText);
    const x = Number(xText);
    const y = Number(yText);
    if (
      !Number.isFinite(uptimeSec) ||
      uptimeSec < 0 ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      continue;
    }
    clicks.push({ button, uptimeSec, x, y });
  }
  return clicks;
}

/** Install only unowned buttons, so teardown never removes a user's existing bind. */
export function installScript(buttons: ClickButton[]): string {
  const lines = [
    '__recso_clicks = {}',
    'local function __recso_uptime() local f = io.open("/proc/uptime", "r"); if not f then return -1 end; local s = f:read("n"); f:close(); return s or -1 end',
  ];
  for (const button of buttons) {
    lines.push(
      `hl.bind("${BUTTON_KEYS[button]}", function() local p = hl.get_cursor_pos() or { x = -1, y = -1 }; table.insert(__recso_clicks, string.format("%s %.3f %.2f %.2f", "${button}", __recso_uptime(), p.x, p.y)) end, { non_consuming = true, ignore_mods = true, transparent = true, description = "${BIND_DESCRIPTION}" })`,
    );
  }
  return lines.join('\n');
}

/** A reply always starts with a header, even when no clicks have accumulated. */
export const DRAIN_SCRIPT =
  'local c = table.concat(__recso_clicks or {}, "\\n"); __recso_clicks = {}; return "clicks\\n" .. c';

/** Unbind only the buttons this capture installed. */
export function removeScript(buttons: ClickButton[]): string {
  return [
    ...buttons.map((button) => `hl.unbind("${BUTTON_KEYS[button]}")`),
    '__recso_clicks = nil',
  ].join('; ');
}

export interface HyprlandClickCapture {
  /** Clicks since the last drain, oldest first. Never throws; returns [] on any error. */
  drain(): Promise<HyprlandClick[]>;
  /** Removes the binds and the Lua global. Idempotent, never throws. */
  stop(): Promise<void>;
}

/** Hyprland closes each IPC connection after one reply, so every command gets a fresh socket. */
function request(socketPath: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    socket.setTimeout(500, () => socket.destroy(new Error('Hyprland IPC timed out')));
    socket.on('connect', () => socket.end(command));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => finish());
    socket.on('close', () => finish());
    socket.on('error', (error) => finish(error));
  });
}

async function currentUptime(): Promise<number> {
  const uptime = await readFile('/proc/uptime', 'utf8');
  return Number(uptime.trim().split(/\s+/)[0]);
}

/** Resolves null when not on Hyprland (no HYPRLAND_INSTANCE_SIGNATURE), when the socket is unreachable, or when Hyprland rejects the install (non-Lua config: the reply to `eval` is not "ok"). Never throws. */
export async function startHyprlandClickCapture(options?: {
  socketPath?: string;
  readUptime?: () => Promise<number>;
  now?: () => number;
}): Promise<HyprlandClickCapture | null> {
  try {
    const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
    if (!signature && options?.socketPath === undefined) {
      return null;
    }
    const runtimePath = path.join(
      process.env.XDG_RUNTIME_DIR ?? '/tmp',
      'hypr',
      signature ?? '',
      '.socket.sock',
    );
    const socketPath =
      options?.socketPath ??
      (existsSync(runtimePath)
        ? runtimePath
        : path.join('/tmp', 'hypr', signature ?? '', '.socket.sock'));

    const binds: unknown = JSON.parse(await request(socketPath, 'j/binds'));
    if (!Array.isArray(binds)) {
      return null;
    }
    const boundBy = (button: ClickButton, ours: boolean): boolean =>
      binds.some(
        (bind: unknown) =>
          typeof bind === 'object' &&
          bind !== null &&
          'key' in bind &&
          bind.key === BUTTON_KEYS[button] &&
          'modmask' in bind &&
          bind.modmask === 0 &&
          ('description' in bind && bind.description === BIND_DESCRIPTION) === ours,
      );
    // Binds left behind by a recording that never stopped (the app crashed)
    // would otherwise read as the user's own and block capture for good.
    const leftovers = BUTTONS.filter((button) => boundBy(button, true));
    if (leftovers.length > 0) {
      await request(socketPath, `eval ${removeScript(leftovers)}`);
    }
    const buttons = BUTTONS.filter((button) => !boundBy(button, false));
    if (buttons.length === 0) {
      return null;
    }

    let monitors: MonitorLayout[] = [];
    try {
      monitors = parseMonitors(JSON.parse(await request(socketPath, 'j/monitors')));
    } catch {
      // Cursor positions still work at scale 1 when monitor information is unavailable.
    }
    if ((await request(socketPath, `eval ${installScript(buttons)}`)).trim() !== 'ok') {
      return null;
    }

    const readUptime = options?.readUptime ?? currentUptime;
    const now = options?.now ?? Date.now;
    let stopped = false;
    return {
      async drain(): Promise<HyprlandClick[]> {
        try {
          const reply = await request(socketPath, `repl ${DRAIN_SCRIPT}`);
          const uptimeNow = await readUptime();
          if (!Number.isFinite(uptimeNow)) {
            return [];
          }
          return parseDrainReply(reply)
            .map((entry) => {
              const point = toPhysical(entry.x, entry.y, monitors);
              return {
                button: entry.button,
                atEpochMs: now() - (uptimeNow - entry.uptimeSec) * 1000,
                x: Math.round(point.x),
                y: Math.round(point.y),
              };
            })
            .sort((a, b) => a.atEpochMs - b.atEpochMs);
        } catch {
          return [];
        }
      },
      async stop(): Promise<void> {
        if (stopped) {
          return;
        }
        stopped = true;
        try {
          await request(socketPath, `eval ${removeScript(buttons)}`);
        } catch {
          // Cleanup is best effort, including when Hyprland has already exited.
        }
      },
    };
  } catch {
    return null;
  }
}
