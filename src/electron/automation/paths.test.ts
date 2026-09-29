import { describe, expect, it } from 'vitest';

import { isAbsolutePath, requireAbsolutePath } from './paths.js';

describe('isAbsolutePath', () => {
  it('accepts rooted POSIX paths only', () => {
    expect(isAbsolutePath('linux', '/home/ana/Videos')).toBe(true);
    expect(isAbsolutePath('linux', 'Videos')).toBe(false);
    expect(isAbsolutePath('linux', './Videos')).toBe(false);
    expect(isAbsolutePath('darwin', '/Users/ana')).toBe(true);
  });

  it('accepts drive-letter and UNC paths on Windows', () => {
    expect(isAbsolutePath('win32', 'C:\\Users\\ana\\Videos')).toBe(true);
    expect(isAbsolutePath('win32', 'd:/footage')).toBe(true);
    expect(isAbsolutePath('win32', '\\\\nas\\share\\videos')).toBe(true);
    expect(isAbsolutePath('win32', '//nas/share/videos')).toBe(true);
  });

  it('refuses Windows paths that depend on the current drive or directory', () => {
    expect(isAbsolutePath('win32', '\\Users\\ana')).toBe(false);
    expect(isAbsolutePath('win32', 'C:Videos')).toBe(false);
    expect(isAbsolutePath('win32', 'Videos')).toBe(false);
    expect(isAbsolutePath('win32', '\\\\nas')).toBe(false);
  });

  it('judges a POSIX path as relative on Windows and a drive path as relative on Linux', () => {
    expect(isAbsolutePath('win32', '/home/ana')).toBe(false);
    expect(isAbsolutePath('linux', 'C:\\Users')).toBe(false);
  });
});

describe('requireAbsolutePath', () => {
  it('normalises with the platform separator', () => {
    expect(requireAbsolutePath('linux', '/a/b/../c', 'dir')).toBe('/a/c');
    expect(requireAbsolutePath('win32', 'C:/a/b/../c', 'dir')).toBe('C:\\a\\c');
  });

  it('throws invalid_params naming the field', () => {
    expect(() => requireAbsolutePath('linux', 'rel', 'outputDir')).toThrow(
      expect.objectContaining({
        reason: 'invalid_params',
        message: expect.stringContaining('outputDir'),
      }),
    );
  });
});
