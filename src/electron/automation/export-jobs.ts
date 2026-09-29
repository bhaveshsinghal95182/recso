/**
 * Track headless export children for the Automation API.
 * Spawning is supplied by the caller so this bookkeeping remains Electron-free.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { AutomationError } from './protocol.js';

export type ExportEncoder = 'auto' | 'hardware' | 'software';
export type ExportState = 'running' | 'finished' | 'failed' | 'cancelled';

export interface ExportJobStatus {
  exportId: string;
  projectDir: string;
  output: string;
  preset: string;
  encoder: ExportEncoder;
  state: ExportState;
  percent: number;
  fps: number;
  etaSeconds: number | null;
  phase: string;
  encoderName: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export interface ChildLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(): boolean;
}

export function exportSpawnPlan(options: {
  execPath: string;
  packaged: boolean;
  appPath: string;
  env: Record<string, string | undefined>;
  projectDir: string;
  output: string;
  preset: string;
  encoder: ExportEncoder;
}): SpawnPlan {
  const env = { ...options.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.RECSO_AUTOMATION;
  env.RECSO_EXPORT_PROTOCOL = '1';
  return {
    command: options.execPath,
    args: [
      ...(options.packaged ? [] : [options.appPath]),
      '--export-project',
      options.projectDir,
      '--export-output',
      options.output,
      '--export-preset',
      options.preset,
      '--export-encoder',
      options.encoder,
    ],
    env,
  };
}

export interface ExportJobsOptions {
  spawn: (plan: SpawnPlan) => ChildLike;
  newId?: () => string;
  now?: () => Date;
  removeFile?: (path: string) => void;
  onEvent?: (
    event: 'export.progress' | 'export.finished' | 'export.failed',
    status: ExportJobStatus,
  ) => void;
  maxFinished?: number;
}

interface Job {
  status: ExportJobStatus;
  child: ChildLike;
  tail: string[];
  completePath: string | null;
  failure: string | null;
  lastProgressAt: number | null;
  exited: boolean;
  removeOnExit: boolean;
  removed: boolean;
  waiters: Set<() => void>;
}

function message(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class ExportJobs {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly options: ExportJobsOptions) {}

  start(
    request: { projectDir: string; output: string; preset: string; encoder: ExportEncoder },
    plan: SpawnPlan,
  ): ExportJobStatus {
    const exportId = this.options.newId?.() ?? randomUUID();
    const child = this.options.spawn(plan);
    const status: ExportJobStatus = {
      exportId,
      ...request,
      state: 'running',
      percent: 0,
      fps: 0,
      etaSeconds: null,
      phase: 'Starting',
      encoderName: null,
      error: null,
      startedAt: this.now().toISOString(),
      finishedAt: null,
    };
    const job: Job = {
      status,
      child,
      tail: [],
      completePath: null,
      failure: null,
      lastProgressAt: null,
      exited: false,
      removeOnExit: false,
      removed: false,
      waiters: new Set(),
    };
    this.jobs.set(exportId, job);
    this.listen(child.stdout, (line) => this.processLine(job, line, true));
    this.listen(child.stderr, (line) => this.processLine(job, line, false));
    child.on('exit', (code) => this.onExit(job, code));
    child.on('error', (error) => {
      if (status.state !== 'running') return;
      status.state = 'failed';
      status.error = error.message;
      this.finish(job, 'export.failed');
    });
    return { ...status };
  }

  get(exportId: string): ExportJobStatus {
    return { ...this.requireJob(exportId).status };
  }

  list(): ExportJobStatus[] {
    return [...this.jobs.values()].reverse().map((job) => ({ ...job.status }));
  }

  runningFor(output: string): ExportJobStatus | null {
    const job = [...this.jobs.values()].find(
      (candidate) => candidate.status.state === 'running' && candidate.status.output === output,
    );
    return job ? { ...job.status } : null;
  }

  cancel(exportId: string): ExportJobStatus {
    const job = this.requireJob(exportId);
    if (job.status.state !== 'running') return { ...job.status };
    job.status.state = 'cancelled';
    job.status.finishedAt = this.now().toISOString();
    const signalled = job.child.kill();
    job.removeOnExit = signalled;
    if (!signalled || job.exited) this.removeOutput(job);
    this.notifyWaiters(job);
    this.prune();
    return { ...job.status };
  }

  wait(exportId: string, timeoutMs: number): Promise<ExportJobStatus> {
    const job = this.requireJob(exportId);
    if (job.status.state !== 'running' || timeoutMs <= 0) {
      return Promise.resolve({ ...job.status });
    }
    return new Promise((resolve) => {
      const complete = () => {
        clearTimeout(timer);
        job.waiters.delete(complete);
        resolve({ ...job.status });
      };
      const timer = setTimeout(complete, timeoutMs);
      job.waiters.add(complete);
    });
  }

  cancelAll(): void {
    for (const [id, job] of this.jobs) {
      if (job.status.state === 'running') this.cancel(id);
    }
  }

  private requireJob(exportId: string): Job {
    const job = this.jobs.get(exportId);
    if (!job) throw new AutomationError('export_not_found', `no export ${exportId}`);
    return job;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private listen(stream: NodeJS.ReadableStream | null, accept: (line: string) => void): void {
    if (!stream) return;
    const decoder = new StringDecoder('utf8');
    let partial = '';
    stream.on('data', (chunk: Buffer | string) => {
      partial += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) accept(line.replace(/\r$/, ''));
    });
  }

  private processLine(job: Job, line: string, stdout: boolean): void {
    if (job.status.state !== 'running') return;
    if (stdout && line.startsWith('@@recso-export ')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.slice('@@recso-export '.length));
      } catch {
        return;
      }
      const item = message(parsed);
      if (
        item?.type === 'progress' &&
        typeof item.percent === 'number' &&
        typeof item.fps === 'number' &&
        typeof item.eta === 'number' &&
        typeof item.phase === 'string'
      ) {
        Object.assign(job.status, {
          percent: item.percent,
          fps: item.fps,
          etaSeconds: item.eta,
          phase: item.phase,
        });
        if (
          Object.hasOwn(item, 'encoder') &&
          (typeof item.encoder === 'string' || item.encoder === null)
        ) {
          job.status.encoderName = item.encoder;
        }
        const now = this.now().getTime();
        if (job.lastProgressAt === null || now - job.lastProgressAt >= 250) {
          job.lastProgressAt = now;
          this.options.onEvent?.('export.progress', { ...job.status });
        }
      } else if (item?.type === 'complete' && typeof item.outputPath === 'string') {
        job.completePath = item.outputPath;
      } else if (item?.type === 'failed' && typeof item.error === 'string') {
        job.failure = item.error;
      }
      return;
    }
    job.tail.push(line);
    if (job.tail.length > 20) job.tail.shift();
  }

  private onExit(job: Job, code: number | null): void {
    job.exited = true;
    if (job.status.state === 'cancelled') {
      if (job.removeOnExit) this.removeOutput(job);
      return;
    }
    if (job.status.state !== 'running') return;
    if (code === 0 && job.completePath !== null) {
      job.status.state = 'finished';
      job.status.percent = 100;
      job.status.output = job.completePath;
      job.status.error = null;
      this.finish(job, 'export.finished');
    } else {
      job.status.state = 'failed';
      job.status.error =
        job.failure ?? `recso's export process exited with code ${code}\n${job.tail.join('\n')}`;
      this.finish(job, 'export.failed');
    }
  }

  private finish(job: Job, event: 'export.finished' | 'export.failed'): void {
    job.status.finishedAt = this.now().toISOString();
    this.options.onEvent?.(event, { ...job.status });
    this.notifyWaiters(job);
    this.prune();
  }

  private notifyWaiters(job: Job): void {
    for (const waiter of job.waiters) waiter();
  }

  private removeOutput(job: Job): void {
    if (job.removed) return;
    job.removed = true;
    try {
      if (this.options.removeFile) this.options.removeFile(job.status.output);
      else fs.rmSync(job.status.output, { force: true });
    } catch {
      // Cleanup must not turn cancellation into an API failure.
    }
  }

  private prune(): void {
    const maxFinished = this.options.maxFinished ?? 20;
    const finished = [...this.jobs].filter(([, job]) => job.status.state !== 'running');
    for (const [id] of finished.slice(0, Math.max(0, finished.length - maxFinished))) {
      this.jobs.delete(id);
    }
  }
}
