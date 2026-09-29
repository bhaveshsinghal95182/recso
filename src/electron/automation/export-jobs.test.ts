import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { ChildLike, ExportJobStatus, SpawnPlan } from './export-jobs.js';
import { ExportJobs, exportSpawnPlan } from './export-jobs.js';

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);

  exit(code: number | null) {
    this.emit('exit', code, null);
  }

  line(value: object) {
    this.stdout.write(`@@recso-export ${JSON.stringify(value)}\n`);
  }
}

const plan: SpawnPlan = { command: 'electron', args: [], env: {} };
const request = {
  projectDir: '/project',
  output: '/output.mp4',
  preset: '1080p',
  encoder: 'auto' as const,
};

function harness(maxFinished?: number) {
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const onEvent = vi.fn();
  const removeFile = vi.fn();
  let clock = 1000;
  let nextId = 0;
  const jobs = new ExportJobs({
    spawn,
    onEvent,
    removeFile,
    maxFinished,
    now: () => new Date(clock),
    newId: () => `job-${++nextId}`,
  });
  return {
    jobs,
    children,
    spawn,
    onEvent,
    removeFile,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('exportSpawnPlan', () => {
  it('builds packaged and development commands without mutating the environment', () => {
    const env = { ELECTRON_RUN_AS_NODE: '1', RECSO_AUTOMATION: '1', KEEP: 'yes' };
    const options = { execPath: '/electron', appPath: '/app', userDataDir: '/ud', env, ...request };
    const expectedArgs = [
      '--user-data-dir=/ud',
      '--export-project',
      '/project',
      '--export-output',
      '/output.mp4',
      '--export-preset',
      '1080p',
      '--export-encoder',
      'auto',
    ];
    expect(exportSpawnPlan({ ...options, packaged: true })).toEqual({
      command: '/electron',
      args: expectedArgs,
      env: { KEEP: 'yes', RECSO_EXPORT_PROTOCOL: '1' },
    });
    expect(exportSpawnPlan({ ...options, packaged: false }).args).toEqual([
      '/app',
      ...expectedArgs,
    ]);
    expect(env).toEqual({ ELECTRON_RUN_AS_NODE: '1', RECSO_AUTOMATION: '1', KEEP: 'yes' });
  });
});

describe('ExportJobs', () => {
  it('parses split progress lines, throttles events, and keeps the latest status', () => {
    const h = harness();
    const id = h.jobs.start(request, plan).exportId;
    expect(h.spawn).toHaveBeenCalledWith(plan);
    const child = h.children[0];
    const line =
      '@@recso-export {"type":"progress","percent":10,"fps":60,"eta":12,"phase":"Encoding","encoder":"NVENC"}\n';
    child.stdout.write(line.slice(0, 31));
    expect(h.jobs.get(id).percent).toBe(0);
    child.stdout.write(line.slice(31));
    expect(h.jobs.get(id)).toMatchObject({
      percent: 10,
      fps: 60,
      etaSeconds: 12,
      phase: 'Encoding',
      encoderName: 'NVENC',
    });
    expect(h.onEvent).toHaveBeenCalledTimes(1);
    h.advance(100);
    child.line({ type: 'progress', percent: 20, fps: 50, eta: 8, phase: 'Muxing', encoder: null });
    expect(h.jobs.get(id)).toMatchObject({
      percent: 20,
      fps: 50,
      etaSeconds: 8,
      phase: 'Muxing',
      encoderName: null,
    });
    expect(h.onEvent).toHaveBeenCalledTimes(1);
    h.advance(150);
    child.line({ type: 'progress', percent: 30, fps: 45, eta: 5, phase: 'Muxing' });
    expect(h.onEvent).toHaveBeenCalledTimes(2);
    expect(h.onEvent).toHaveBeenLastCalledWith(
      'export.progress',
      expect.objectContaining({ percent: 30 }),
    );
  });

  it('finishes only after a zero exit and uses the reported output path', () => {
    const h = harness();
    const started = h.jobs.start(request, plan);
    h.children[0].line({ type: 'progress', percent: 80, fps: 24, eta: 1, phase: 'Encoding' });
    h.children[0].line({ type: 'complete', outputPath: '/reported.mp4' });
    expect(h.jobs.get(started.exportId).state).toBe('running');
    h.advance(1000);
    h.children[0].exit(0);
    expect(h.jobs.get(started.exportId)).toMatchObject({
      state: 'finished',
      percent: 100,
      output: '/reported.mp4',
      error: null,
      finishedAt: new Date(2000).toISOString(),
    });
    expect(h.onEvent).toHaveBeenLastCalledWith(
      'export.finished',
      expect.objectContaining({ state: 'finished' }),
    );
    const copy = h.jobs.get(started.exportId);
    copy.percent = 1;
    expect(h.jobs.get(started.exportId).percent).toBe(100);
  });

  it('uses a failed marker and emits failure only on exit', () => {
    const h = harness();
    const id = h.jobs.start(request, plan).exportId;
    h.children[0].line({ type: 'failed', error: 'encoder broke' });
    expect(h.jobs.get(id).state).toBe('running');
    h.children[0].exit(2);
    expect(h.jobs.get(id)).toMatchObject({ state: 'failed', error: 'encoder broke' });
    expect(h.onEvent).toHaveBeenCalledWith(
      'export.failed',
      expect.objectContaining({ error: 'encoder broke' }),
    );
  });

  it('includes only the last 20 noise lines for an unexplained failure', () => {
    const h = harness();
    const id = h.jobs.start(request, plan).exportId;
    for (let n = 0; n < 25; n += 1) {
      const stream = n % 2 ? h.children[0].stdout : h.children[0].stderr;
      stream.write(`log-${n}\n`);
    }
    h.children[0].stdout.write('@@recso-export {bad json}\n');
    h.children[0].exit(3);
    const error = h.jobs.get(id).error;
    expect(error).toContain("recso's export process exited with code 3\nlog-5");
    expect(error).toContain('log-24');
    expect(error).not.toContain('log-0\n');
    expect(error).not.toContain('bad json');
  });

  it('handles spawn errors once even if an exit follows', () => {
    const h = harness();
    const id = h.jobs.start(request, plan).exportId;
    h.children[0].emit('error', new Error('cannot launch'));
    h.children[0].exit(1);
    expect(h.jobs.get(id)).toMatchObject({ state: 'failed', error: 'cannot launch' });
    expect(h.onEvent).toHaveBeenCalledTimes(1);
  });

  it('cancels immediately but removes output after exit and only once', () => {
    const h = harness();
    const id = h.jobs.start(request, plan).exportId;
    expect(h.jobs.cancel(id)).toMatchObject({
      state: 'cancelled',
      finishedAt: new Date(1000).toISOString(),
    });
    expect(h.children[0].kill).toHaveBeenCalledTimes(1);
    expect(h.removeFile).not.toHaveBeenCalled();
    h.children[0].exit(null);
    h.children[0].exit(null);
    h.children[0].emit('error', new Error('after cancel'));
    expect(h.removeFile).toHaveBeenCalledTimes(1);
    expect(h.removeFile).toHaveBeenCalledWith('/output.mp4');
    expect(h.onEvent).not.toHaveBeenCalled();
  });

  it('removes output immediately if kill returns false', () => {
    const h = harness();
    const id = h.jobs.start(request, plan).exportId;
    h.children[0].kill.mockReturnValue(false);
    h.jobs.cancel(id);
    expect(h.removeFile).toHaveBeenCalledWith('/output.mp4');
    h.children[0].exit(null);
    expect(h.removeFile).toHaveBeenCalledTimes(1);
  });

  it('leaves completed jobs unchanged when cancelled', () => {
    const h = harness();
    const id = h.jobs.start(request, plan).exportId;
    h.children[0].line({ type: 'complete', outputPath: '/output.mp4' });
    h.children[0].exit(0);
    const before = h.jobs.get(id);
    expect(h.jobs.cancel(id)).toEqual(before);
    expect(h.children[0].kill).not.toHaveBeenCalled();
  });

  it('waits for completion, times out with current status, and handles zero timeouts', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const id = h.jobs.start(request, plan).exportId;
      await expect(h.jobs.wait(id, 0)).resolves.toMatchObject({ state: 'running' });
      const finished = h.jobs.wait(id, 1000);
      h.children[0].line({ type: 'complete', outputPath: '/output.mp4' });
      h.children[0].exit(0);
      await expect(finished).resolves.toMatchObject({ state: 'finished' });
      await expect(h.jobs.wait(id, 1000)).resolves.toMatchObject({ state: 'finished' });
      const second = h.jobs.start({ ...request, output: '/other.mp4' }, plan).exportId;
      const timeout = h.jobs.wait(second, 25);
      await vi.advanceTimersByTimeAsync(25);
      await expect(timeout).resolves.toMatchObject({ state: 'running' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds exact running outputs and rejects unknown ids', () => {
    const h = harness();
    const id = h.jobs.start(request, plan).exportId;
    expect(h.jobs.runningFor('/output.mp4')?.exportId).toBe(id);
    expect(h.jobs.runningFor('/OUTPUT.mp4')).toBeNull();
    expect(() => h.jobs.get('missing')).toThrow(
      expect.objectContaining({ reason: 'export_not_found' }),
    );
    h.children[0].line({ type: 'complete', outputPath: '/output.mp4' });
    h.children[0].exit(0);
    expect(h.jobs.runningFor('/output.mp4')).toBeNull();
  });

  it('prunes oldest finished jobs but retains every running job', () => {
    const h = harness(2);
    const running = h.jobs.start({ ...request, output: '/running.mp4' }, plan).exportId;
    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      ids.push(h.jobs.start({ ...request, output: `/done-${n}.mp4` }, plan).exportId);
      h.children[n + 1].line({ type: 'complete', outputPath: `/done-${n}.mp4` });
      h.children[n + 1].exit(0);
    }
    expect(h.jobs.list().map((item: ExportJobStatus) => item.exportId)).toEqual([
      ids[2],
      ids[1],
      running,
    ]);
    expect(() => h.jobs.get(ids[0])).toThrow(
      expect.objectContaining({ reason: 'export_not_found' }),
    );
  });

  it('cancelAll cancels each running child', () => {
    const h = harness();
    h.jobs.start(request, plan);
    h.jobs.start({ ...request, output: '/second.mp4' }, plan);
    h.jobs.cancelAll();
    expect(h.jobs.list().map((item) => item.state)).toEqual(['cancelled', 'cancelled']);
    expect(h.children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
  });
});
