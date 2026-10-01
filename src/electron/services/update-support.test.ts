import { describe, expect, it } from 'vitest';

import { updateSupport } from './update-support.js';

const packaged = { isPackaged: true, windowsStore: false, appImage: undefined };

describe('updateSupport', () => {
  it('leaves development runs alone', () => {
    expect(updateSupport({ ...packaged, isPackaged: false, platform: 'win32' })).toEqual({
      supported: false,
      reason: 'development',
    });
    expect(
      updateSupport({ ...packaged, isPackaged: false, platform: 'linux', appImage: '/a.AppImage' }),
    ).toEqual({ supported: false, reason: 'development' });
  });

  it('updates the Windows installer build but not the Store build', () => {
    expect(updateSupport({ ...packaged, platform: 'win32' })).toEqual({ supported: true });
    expect(updateSupport({ ...packaged, platform: 'win32', windowsStore: true })).toEqual({
      supported: false,
      reason: 'windows-store',
    });
  });

  it('updates an AppImage but leaves the deb to the package manager', () => {
    expect(
      updateSupport({ ...packaged, platform: 'linux', appImage: '/home/me/recso.AppImage' }),
    ).toEqual({ supported: true });
    expect(updateSupport({ ...packaged, platform: 'linux' })).toEqual({
      supported: false,
      reason: 'linux-package',
    });
  });

  it('does nothing on platforms without a release', () => {
    expect(updateSupport({ ...packaged, platform: 'darwin' })).toEqual({
      supported: false,
      reason: 'platform',
    });
  });
});
