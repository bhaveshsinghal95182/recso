import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { moveFileSync } from './move-file.js';

describe('moveFileSync', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-file-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function exdev(): never {
    throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
  }

  it('renames within one filesystem', () => {
    const from = path.join(dir, 'a.mp4');
    const to = path.join(dir, 'b.mp4');
    fs.writeFileSync(from, 'video');

    moveFileSync(from, to);

    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(to, 'utf8')).toBe('video');
  });

  it('copies and removes the source when rename crosses filesystems', () => {
    const from = path.join(dir, 'a.mp4');
    const to = path.join(dir, 'b.mp4');
    fs.writeFileSync(from, 'video');

    moveFileSync(from, to, exdev);

    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(to, 'utf8')).toBe('video');
  });

  it('keeps the source when the copy fails', () => {
    const from = path.join(dir, 'a.mp4');
    fs.writeFileSync(from, 'video');

    expect(() => moveFileSync(from, path.join(dir, 'missing', 'b.mp4'), exdev)).toThrow();
    expect(fs.readFileSync(from, 'utf8')).toBe('video');
  });

  it('passes other rename errors through', () => {
    const denied = () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    expect(() => moveFileSync('a', 'b', denied)).toThrow('denied');
  });
});
