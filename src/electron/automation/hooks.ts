/**
 * Run user hooks for Automation API events without letting event data become shell syntax.
 * Commands come only from a local file, so callers cannot install hooks through the API.
 * Hook stdin can close before a write completes; its errors must not crash recso.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const HOOKS_FILE = 'automation.json';

/** [file, ...args]; must be non-empty. */
export type HookCommand = string[];

/** event name -> commands to run for it. */
export type HooksConfig = Record<string, HookCommand[]>;

export interface HooksLoadResult {
  hooks: HooksConfig;
  errors: string[];
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse the file's text. Never throws. */
export function parseHooksConfig(text: string, knownEvents: readonly string[]): HooksLoadResult {
  const hooks: HooksConfig = {};
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return { hooks, errors: [`${HOOKS_FILE} is not valid JSON: ${errorMessage(error)}`] };
  }
  const config = object(parsed);
  if (!config) return { hooks, errors: [`${HOOKS_FILE} must be a JSON object`] };
  if (!Object.hasOwn(config, 'hooks')) return { hooks, errors };
  const entries = object(config.hooks);
  if (!entries) return { hooks, errors: [`${HOOKS_FILE} "hooks" must be an object`] };

  const known = new Set(knownEvents);
  for (const [eventName, value] of Object.entries(entries)) {
    if (!known.has(eventName)) {
      errors.push(`unknown event "${eventName}"`);
      continue;
    }
    if (!Array.isArray(value)) {
      errors.push(`${HOOKS_FILE} hooks["${eventName}"] must be an array of commands`);
      continue;
    }
    const commands: HookCommand[] = [];
    for (const [index, command] of value.entries()) {
      if (
        !Array.isArray(command) ||
        command.length === 0 ||
        !command.every((part: unknown) => typeof part === 'string') ||
        command[0].length === 0
      ) {
        errors.push(
          `${HOOKS_FILE} hooks["${eventName}"][${index}] must be a non-empty array of strings`,
        );
        continue;
      }
      commands.push(command as string[]);
    }
    if (commands.length > 0) {
      Object.defineProperty(hooks, eventName, {
        value: commands,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return { hooks, errors };
}

/** Read <userDataDir>/automation.json. Missing file => { hooks: {}, errors: [] }. Never throws. */
export function readHooksConfig(
  userDataDir: string,
  knownEvents: readonly string[],
): HooksLoadResult {
  try {
    return parseHooksConfig(
      fs.readFileSync(path.join(userDataDir, HOOKS_FILE), 'utf8'),
      knownEvents,
    );
  } catch (error) {
    if (object(error)?.code === 'ENOENT') return { hooks: {}, errors: [] };
    return { hooks: {}, errors: [`${HOOKS_FILE} could not be read: ${errorMessage(error)}`] };
  }
}

/**
 * A loader that re-reads the file only when its mtime or size changed (via fs.statSync).
 * A missing file counts as empty. Each distinct set of errors is passed to `onErrors` once
 * per change of the underlying file (not once per call).
 */
export function cachedHooksLoader(
  userDataDir: string,
  knownEvents: readonly string[],
  onErrors?: (errors: string[]) => void,
): () => HooksConfig {
  let lastStat: { mtimeMs: number; size: number } | null = null;
  let cached: HooksConfig = {};
  let reported: string | null = null;
  return () => {
    try {
      const { mtimeMs, size } = fs.statSync(path.join(userDataDir, HOOKS_FILE));
      if (lastStat?.mtimeMs === mtimeMs && lastStat.size === size) return cached;
      const result = readHooksConfig(userDataDir, knownEvents);
      lastStat = { mtimeMs, size };
      cached = result.hooks;
      const current = result.errors.length > 0 ? JSON.stringify(result.errors) : null;
      if (current !== null && current !== reported) {
        try {
          onErrors?.(result.errors);
        } catch {
          // A diagnostic callback must not stop event delivery.
        }
      }
      reported = current;
    } catch {
      if (lastStat !== null) cached = {};
      lastStat = null;
      reported = null;
    }
    return cached;
  };
}

export interface HookSpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * How to spawn one hook command without a shell. Throws an Error with a clear message when the
 * command can't be run safely.
 */
export function hookSpawnPlan(
  platform: NodeJS.Platform,
  command: HookCommand,
  env: Record<string, string | undefined>,
): HookSpawnPlan {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command[0])) {
    return { file: command[0], args: command.slice(1), windowsVerbatimArguments: false };
  }
  for (const part of command) {
    if (/["%\r\n\0]/.test(part)) {
      throw new Error(
        `batch-file hooks can't take argument ${JSON.stringify(part)}; use a .exe or PowerShell script instead`,
      );
    }
  }
  const quoted = command.map((part) => `"${part}"`).join(' ');
  return {
    file: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${quoted}"`],
    windowsVerbatimArguments: true,
  };
}

/** The hook's environment: base env plus RECSO_EVENT, RECSO_PROJECT_DIR, RECSO_OUTPUT. */
export function hookEnv(
  event: string,
  payload: unknown,
  baseEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = { ...baseEnv, RECSO_EVENT: event };
  const data = object(payload);
  if (typeof data?.projectDir === 'string' && data.projectDir.length > 0) {
    result.RECSO_PROJECT_DIR = data.projectDir;
  } else {
    delete result.RECSO_PROJECT_DIR;
  }
  if (typeof data?.output === 'string') {
    result.RECSO_OUTPUT = data.output;
  } else if (typeof data?.videoPath === 'string') {
    result.RECSO_OUTPUT = data.videoPath;
  } else {
    delete result.RECSO_OUTPUT;
  }
  return result;
}

export interface HookChild {
  stdin: NodeJS.WritableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export interface HookRunnerOptions {
  platform: NodeJS.Platform;
  loadHooks: () => HooksConfig;
  spawn: (plan: HookSpawnPlan, env: Record<string, string | undefined>) => HookChild;
  log: (message: string) => void;
  /** default process.env */
  env?: Record<string, string | undefined>;
  /** default 60_000 */
  timeoutMs?: number;
  /** default 8 */
  maxConcurrent?: number;
}

interface RunningHook {
  child: HookChild;
  timer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  finished: boolean;
  timedOut: boolean;
  stderr: string;
}

export class HookRunner {
  private readonly active = new Set<RunningHook>();
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;

  constructor(private readonly options: HookRunnerOptions) {
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxConcurrent = options.maxConcurrent ?? 8;
  }

  /** Start every hook configured for this event. Never throws, never awaits the hooks. */
  run(event: string, payload: unknown): void {
    let hooks: HooksConfig;
    try {
      hooks = this.options.loadHooks();
    } catch (error) {
      this.log(`hooks for ${event} could not be loaded: ${errorMessage(error)}`);
      return;
    }
    const commands = Object.hasOwn(hooks, event) ? hooks[event] : [];
    for (const command of commands ?? []) {
      if (this.running() >= this.maxConcurrent) {
        this.log(`hook skipped for ${event}: ${this.maxConcurrent} hooks already running`);
        continue;
      }
      this.start(event, payload, command);
    }
  }

  /** Number of hooks still running. */
  running(): number {
    return this.active.size;
  }

  /** Kill every running hook (used when the API is turned off or recso quits). */
  stopAll(): void {
    for (const hook of this.active) {
      this.clearTimers(hook);
      try {
        hook.child.kill('SIGTERM');
      } catch {
        // Shutdown continues for the remaining hooks.
      }
    }
  }

  private start(event: string, payload: unknown, command: HookCommand): void {
    const env = hookEnv(event, payload, this.env);
    let child: HookChild;
    try {
      const plan = hookSpawnPlan(this.options.platform, command, env);
      child = this.options.spawn(plan, env);
    } catch (error) {
      this.log(`hook ${command[0]} for ${event} not run: ${errorMessage(error)}`);
      return;
    }
    const hook: RunningHook = {
      child,
      timer: null,
      killTimer: null,
      finished: false,
      timedOut: false,
      stderr: '',
    };
    this.active.add(hook);
    this.listen(hook, event, command[0]);
    this.writeInput(hook, event, payload);
    hook.timer = setTimeout(() => this.timeout(hook, event, command[0]), this.timeoutMs);
    hook.timer.unref?.();
  }

  private listen(hook: RunningHook, event: string, file: string): void {
    hook.child.stderr?.on('data', (chunk: Buffer | string) => {
      hook.stderr = (hook.stderr + chunk.toString()).slice(-2048);
    });
    hook.child.on('error', (error) => {
      if (hook.finished) return;
      this.log(`hook ${file} for ${event} failed to start: ${error.message}`);
      this.finish(hook);
    });
    hook.child.on('exit', (code, signal) => {
      if (hook.finished) return;
      if (!hook.timedOut && code !== 0) {
        this.log(`hook ${file} for ${event} exited with ${code ?? signal}: ${hook.stderr.trim()}`);
      }
      this.finish(hook);
    });
  }

  private writeInput(hook: RunningHook, event: string, payload: unknown): void {
    const stdin = hook.child.stdin;
    if (!stdin) return;
    stdin.on('error', () => {});
    try {
      stdin.end(`${JSON.stringify({ event, data: payload })}\n`);
    } catch {
      // Closed stdin or unserializable event data must not escape run().
    }
  }

  private timeout(hook: RunningHook, event: string, file: string): void {
    if (hook.finished) return;
    hook.timedOut = true;
    try {
      hook.child.kill('SIGTERM');
    } catch {
      // The exit or error event will finish this child if it arrives.
    }
    this.log(`hook ${file} for ${event} killed after ${this.timeoutMs / 1000}s`);
    if (hook.finished) return;
    hook.killTimer = setTimeout(() => {
      if (!hook.finished) {
        try {
          hook.child.kill('SIGKILL');
        } catch {
          // A failed kill must not crash the event bridge.
        }
      }
    }, 5000);
    hook.killTimer.unref?.();
  }

  private finish(hook: RunningHook): void {
    if (hook.finished) return;
    hook.finished = true;
    this.clearTimers(hook);
    this.active.delete(hook);
  }

  private clearTimers(hook: RunningHook): void {
    if (hook.timer) clearTimeout(hook.timer);
    if (hook.killTimer) clearTimeout(hook.killTimer);
    hook.timer = null;
    hook.killTimer = null;
  }

  private log(message: string): void {
    try {
      this.options.log(message);
    } catch {
      // Logging must not change hook execution.
    }
  }
}

/** Production spawn adapter (not used in most tests, which pass a fake `spawn`). */
export function spawnHook(plan: HookSpawnPlan, env: Record<string, string | undefined>): HookChild {
  return spawn(plan.file, plan.args, {
    env,
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    shell: false,
  });
}
