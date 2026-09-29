import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ChildLike, ExportJobs, type SpawnPlan } from '../export-jobs.js';
import type { JsonRpcResponse } from '../protocol.js';
import { MethodRegistry } from '../registry.js';
import type { AutomationServices } from '../services.js';
import { fakeServices } from '../testing.js';
import { exportBaseName, registerProjectMethods, resolveExportOutput } from './projects.js';

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  send(message: Record<string, unknown>) {
    this.stdout.write(`@@recso-export ${JSON.stringify(message)}\n`);
  }
}

let root: string;

function makeProject(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.recso'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.mp4`), 'video');
  fs.writeFileSync(
    path.join(dir, '.recso', 'project.json'),
    JSON.stringify({
      id: `id-${name}`,
      name,
      recordingId: `rec-${name}`,
      rawVideoPath: path.join(dir, `${name}.mp4`),
      videoDimensions: { width: 1280, height: 720 },
      timeline: { duration: 5000, tracks: [] },
      createdAt: 1_700_000_000_000,
      modifiedAt: 1_700_000_000_000,
    }),
  );
  return dir;
}

function setup(overrides: Partial<AutomationServices> = {}) {
  const children: FakeChild[] = [];
  const plans: SpawnPlan[] = [];
  const exports = new ExportJobs({
    spawn: (plan) => {
      plans.push(plan);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    removeFile: () => undefined,
  });
  // Real temp paths, so the host's own path rules.
  const services = fakeServices({ platform: process.platform, exports, ...overrides });
  const registry = new MethodRegistry();
  registerProjectMethods(registry, services);
  const call = (method: string, params: unknown = {}): Promise<JsonRpcResponse> =>
    registry.call(1, method, params, {});
  return { services, call, children, plans };
}

function resultOf(response: JsonRpcResponse): Record<string, unknown> {
  if (!('result' in response)) throw new Error(JSON.stringify(response));
  return response.result as Record<string, unknown>;
}

function reasonOf(response: JsonRpcResponse): string | undefined {
  return 'error' in response ? response.error.data?.reason : undefined;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-projects-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveExportOutput', () => {
  const base = {
    platform: 'linux' as const,
    projectDir: '/v/take',
    projectName: 'take',
    outputDir: null,
    overwrite: false,
  };

  it("defaults to the project's exports folder, numbered when taken", () => {
    expect(resolveExportOutput({ ...base, exists: () => false })).toBe('/v/take/exports/take.mp4');
    const taken = new Set(['/v/take/exports/take.mp4', '/v/take/exports/take-2.mp4']);
    expect(resolveExportOutput({ ...base, exists: (p) => taken.has(p) })).toBe(
      '/v/take/exports/take-3.mp4',
    );
    expect(resolveExportOutput({ ...base, overwrite: true, exists: (p) => taken.has(p) })).toBe(
      '/v/take/exports/take.mp4',
    );
  });

  it('uses export.outputDir when set', () => {
    expect(
      resolveExportOutput({ ...base, outputDir: '/v/Media/Footage', exists: () => false }),
    ).toBe('/v/Media/Footage/take.mp4');
  });

  it('enforces overwrite for an explicit output', () => {
    expect(() =>
      resolveExportOutput({ ...base, requested: '/out/a.mp4', exists: () => true }),
    ).toThrow(expect.objectContaining({ reason: 'output_exists' }));
    expect(
      resolveExportOutput({
        ...base,
        requested: '/out/a.mp4',
        overwrite: true,
        exists: () => true,
      }),
    ).toBe('/out/a.mp4');
    expect(() =>
      resolveExportOutput({ ...base, requested: '/out/a.mov', exists: () => false }),
    ).toThrow(expect.objectContaining({ reason: 'invalid_params' }));
    expect(() =>
      resolveExportOutput({ ...base, requested: 'out/a.mp4', exists: () => false }),
    ).toThrow(expect.objectContaining({ reason: 'invalid_params' }));
  });

  it('builds Windows paths on Windows', () => {
    expect(
      resolveExportOutput({
        ...base,
        platform: 'win32',
        projectDir: 'C:\\Videos\\take',
        exists: () => false,
      }),
    ).toBe('C:\\Videos\\take\\exports\\take.mp4');
    expect(() =>
      resolveExportOutput({
        ...base,
        platform: 'win32',
        requested: '/out/a.mp4',
        exists: () => false,
      }),
    ).toThrow(expect.objectContaining({ reason: 'invalid_params' }));
  });

  it('makes project names safe file names', () => {
    expect(exportBaseName('a/b:c?')).toBe('a_b_c_');
    expect(exportBaseName('  ...  ')).toBe('export');
    expect(exportBaseName('take. ')).toBe('take');
  });
});

describe('projects.*', () => {
  it('lists recents, skipping ones that are gone', async () => {
    const dir = makeProject('one');
    const { call } = setup({ recentProjectDirs: () => [path.join(root, 'gone'), dir] });
    const result = resultOf(await call('projects.list'));
    expect((result.projects as { name: string }[]).map((project) => project.name)).toEqual(['one']);
  });

  it('lists a folder and gets one project', async () => {
    const dir = makeProject('two');
    makeProject('three');
    const { call } = setup();
    const listed = resultOf(await call('projects.list', { dir: root, limit: 1 }));
    expect(listed.projects).toHaveLength(1);
    expect(resultOf(await call('projects.get', { projectDir: dir }))).toMatchObject({
      name: 'two',
      durationMs: 5000,
      exports: [],
    });
    expect(reasonOf(await call('projects.get', { projectDir: root }))).toBe('project_not_found');
    expect(reasonOf(await call('projects.get', { projectDir: 'two' }))).toBe('invalid_params');
  });

  it('opens a project unless recording', async () => {
    const dir = makeProject('four');
    const openProject = vi.fn();
    const { call } = setup({ openProject });
    expect(resultOf(await call('projects.open', { projectDir: dir }))).toEqual({
      opened: true,
      projectDir: dir,
    });
    expect(openProject).toHaveBeenCalledWith(dir);

    const busy = setup({
      openProject,
      recordingState: () => ({
        state: 'recording',
        recordingId: 'r',
        durationMs: 1,
        bytesWritten: 1,
      }),
    });
    expect(reasonOf(await busy.call('projects.open', { projectDir: dir }))).toBe('busy');
  });
});

describe('export.*', () => {
  it('starts an export with the settings and follows it to the end', async () => {
    const dir = makeProject('five');
    const ensureDir = vi.fn();
    const { call, children, plans, services } = setup({ ensureDir });
    services.settings.set({ 'export.preset': '720p-medium' });

    const started = resultOf(await call('export.start', { projectDir: dir, encoder: 'hardware' }));
    expect(started).toMatchObject({
      state: 'running',
      output: path.join(dir, 'exports', 'five.mp4'),
      preset: '720p-medium',
      encoder: 'hardware',
    });
    expect(ensureDir).toHaveBeenCalledWith(path.join(dir, 'exports'));
    expect(plans[0].args).toContain(path.join(dir, 'exports', 'five.mp4'));

    const exportId = started.exportId as string;
    const waiting = call('export.wait', { exportId, timeoutMs: 5000 });
    children[0].send({
      type: 'progress',
      percent: 50,
      fps: 120,
      eta: 1,
      phase: 'Encoding',
      encoder: 'NVENC',
    });
    children[0].send({ type: 'complete', outputPath: started.output });
    await new Promise((resolve) => setTimeout(resolve, 10));
    children[0].emit('exit', 0, null);

    expect(resultOf(await waiting)).toMatchObject({
      state: 'finished',
      percent: 100,
      encoderName: 'NVENC',
    });
    expect(resultOf(await call('export.progress', { exportId }))).toMatchObject({
      state: 'finished',
    });
  });

  it('honours export.outputDir and refuses an existing output', async () => {
    const dir = makeProject('six');
    const footage = path.join(root, 'Footage');
    const { call, services } = setup({ pathExists: (p) => fs.existsSync(p) });
    services.settings.set({ 'export.outputDir': footage });
    expect(resultOf(await call('export.start', { projectDir: dir }))).toMatchObject({
      output: path.join(footage, 'six.mp4'),
    });

    const existing = path.join(root, 'existing.mp4');
    fs.writeFileSync(existing, 'x');
    expect(reasonOf(await call('export.start', { projectDir: dir, output: existing }))).toBe(
      'output_exists',
    );
    expect(
      resultOf(await call('export.start', { projectDir: dir, output: existing, overwrite: true })),
    ).toMatchObject({ output: existing });
  });

  it('cancels, and reports unknown ids and bad presets', async () => {
    const dir = makeProject('seven');
    const { call, children } = setup();
    const started = resultOf(await call('export.start', { projectDir: dir }));
    const cancelled = resultOf(await call('export.cancel', { exportId: started.exportId }));
    expect(cancelled.state).toBe('cancelled');
    expect(children[0].kill).toHaveBeenCalled();
    expect(reasonOf(await call('export.progress', { exportId: 'nope' }))).toBe('export_not_found');
    expect(reasonOf(await call('export.start', { projectDir: dir, preset: '8k-high' }))).toBe(
      'invalid_params',
    );
  });
});
