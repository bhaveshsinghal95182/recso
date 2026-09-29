import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { listProjectsInDir, readProjectSummary } from './projects.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-projects-'));
  function project(name: string, fields: Record<string, unknown>) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, '.recso'), { recursive: true });
    const video = path.join(dir, 'capture.mp4');
    fs.writeFileSync(video, 'video');
    fs.writeFileSync(
      path.join(dir, '.recso', 'project.json'),
      JSON.stringify({
        id: name,
        name,
        recordingId: `recording-${name}`,
        rawVideoPath: video,
        ...fields,
      }),
    );
    return { dir, video };
  }
  const older = project('older', {
    videoDimensions: { width: 1920, height: 1080 },
    timeline: { duration: 5000 },
    createdAt: 1000,
    modifiedAt: 2000,
  });
  const newer = project('newer', { createdAt: 3000, modifiedAt: 4000 });
  const camera = path.join(older.dir, 'capture_camera.mp4');
  fs.writeFileSync(camera, 'camera');
  const thumbnail = path.join(older.dir, '.recso', 'thumbnail.jpg');
  fs.writeFileSync(thumbnail, 'jpg');
  const exportsDir = path.join(older.dir, 'exports');
  fs.mkdirSync(exportsDir);
  const first = path.join(exportsDir, 'first.mp4');
  const latest = path.join(exportsDir, 'latest.MP4');
  fs.writeFileSync(first, 'first');
  fs.writeFileSync(latest, 'latest');
  fs.writeFileSync(path.join(exportsDir, 'notes.txt'), 'skip');
  fs.mkdirSync(path.join(exportsDir, 'nested.mp4'));
  fs.utimesSync(first, new Date(10000), new Date(10000));
  fs.utimesSync(latest, new Date(20000), new Date(20000));
  fs.mkdirSync(path.join(root, 'empty'));
  project('.hidden', { modifiedAt: 99999 });
  const broken = path.join(root, 'broken');
  fs.mkdirSync(path.join(broken, '.recso'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.recso', 'project.json'), '{broken');
  return { root, older, newer, camera, thumbnail, first, latest, broken };
}

describe('readProjectSummary', () => {
  it('reads media, thumbnail, dimensions, and newest exports', () => {
    const data = fixture();
    const summary = readProjectSummary(data.older.dir);
    expect(summary).toMatchObject({
      projectDir: data.older.dir,
      name: 'older',
      recordingId: 'recording-older',
      videoPath: data.older.video,
      cameraPath: data.camera,
      thumbnailPath: data.thumbnail,
      durationMs: 5000,
      width: 1920,
      height: 1080,
      createdAt: new Date(1000).toISOString(),
      modifiedAt: new Date(2000).toISOString(),
    });
    expect(summary.exports.map((entry) => entry.path)).toEqual([data.latest, data.first]);
    expect(summary.exports[0]).toMatchObject({
      sizeBytes: 6,
      modifiedAt: new Date(20000).toISOString(),
    });
  });

  it('defaults optional fields and timestamps from project.json mtime', () => {
    const { newer } = fixture();
    const projectPath = path.join(newer.dir, '.recso', 'project.json');
    const contents = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Record<string, unknown>;
    delete contents.createdAt;
    delete contents.modifiedAt;
    fs.writeFileSync(projectPath, JSON.stringify(contents));
    const summary = readProjectSummary(newer.dir);
    expect(summary).toMatchObject({
      cameraPath: null,
      thumbnailPath: null,
      durationMs: 0,
      width: 0,
      height: 0,
      exports: [],
      createdAt: new Date(fs.statSync(projectPath).mtimeMs).toISOString(),
      modifiedAt: new Date(fs.statSync(projectPath).mtimeMs).toISOString(),
    });
  });

  it('reports missing and malformed projects', () => {
    const { root, broken } = fixture();
    expect(() => readProjectSummary(path.join(root, 'empty'))).toThrow(
      expect.objectContaining({ reason: 'project_not_found' }),
    );
    expect(() => readProjectSummary(broken)).toThrow(
      expect.objectContaining({ reason: 'invalid_project' }),
    );
  });

  it('rejects a project without a video path and ignores a non-directory exports path', () => {
    const { newer } = fixture();
    fs.writeFileSync(path.join(newer.dir, 'exports'), 'not a folder');
    expect(readProjectSummary(newer.dir).exports).toEqual([]);
    const projectPath = path.join(newer.dir, '.recso', 'project.json');
    const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Record<string, unknown>;
    delete project.rawVideoPath;
    fs.writeFileSync(projectPath, JSON.stringify(project));
    expect(() => readProjectSummary(newer.dir)).toThrow(
      expect.objectContaining({ reason: 'invalid_project' }),
    );
  });
});

describe('listProjectsInDir', () => {
  it('sorts valid visible immediate projects and applies a clamped limit', () => {
    const { root, older, newer } = fixture();
    expect(listProjectsInDir(root).map((item) => item.projectDir)).toEqual([newer.dir, older.dir]);
    expect(listProjectsInDir(root, { limit: 1 }).map((item) => item.projectDir)).toEqual([
      newer.dir,
    ]);
    expect(listProjectsInDir(root, { limit: 0 })).toHaveLength(1);
    expect(listProjectsInDir(root, { limit: -3 })).toHaveLength(1);
  });

  it('rejects missing paths and files', () => {
    const { root, older } = fixture();
    for (const dir of [path.join(root, 'missing'), older.video]) {
      expect(() => listProjectsInDir(dir)).toThrow(
        expect.objectContaining({ reason: 'not_found' }),
      );
    }
  });

  it('uses the injectable filesystem', () => {
    const projectDir = '/virtual/example';
    const projectPath = path.join(projectDir, '.recso', 'project.json');
    const existsSync = vi.fn((p: string) => p === projectPath);
    const summary = readProjectSummary(projectDir, {
      existsSync,
      readFileSync: () =>
        JSON.stringify({ name: 'Virtual', recordingId: 'v1', rawVideoPath: '/video.mov' }),
      readdirSync: () => [],
      statSync: () => ({ size: 0, mtimeMs: 1234, isDirectory: () => false }),
    });
    expect(summary.name).toBe('Virtual');
    expect(summary.createdAt).toBe(new Date(1234).toISOString());
    expect(existsSync).toHaveBeenCalledWith(projectPath);
  });
});
