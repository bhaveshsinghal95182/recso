import { describe, expect, it } from 'vitest';

import { clickAccessHint, INPUT_GROUP_COMMAND, linuxClickSource } from './linux-clicks.js';

describe('linuxClickSource', () => {
  it('uses Hyprland binds under Hyprland, even though it is Wayland', () => {
    expect(
      linuxClickSource({ HYPRLAND_INSTANCE_SIGNATURE: 'abc', XDG_SESSION_TYPE: 'wayland' }),
    ).toBe('hyprland');
  });

  it('reads the devices on other Wayland desktops', () => {
    expect(linuxClickSource({ XDG_SESSION_TYPE: 'wayland' })).toBe('evdev');
    expect(linuxClickSource({ WAYLAND_DISPLAY: 'wayland-0' })).toBe('evdev');
  });

  it('keeps the X11 hook in an X11 session', () => {
    expect(linuxClickSource({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' })).toBe('x11');
  });
});

describe('clickAccessHint', () => {
  it('asks to join the input group when no device can be read', () => {
    expect(clickAccessHint('evdev', { devices: 2, readable: 0 })).toContain(INPUT_GROUP_COMMAND);
  });

  it('says nothing when a device can be read, none exist, or evdev is not used', () => {
    expect(clickAccessHint('evdev', { devices: 2, readable: 1 })).toBeNull();
    expect(clickAccessHint('evdev', { devices: 0, readable: 0 })).toBeNull();
    expect(clickAccessHint('evdev', null)).toBeNull();
    expect(clickAccessHint('hyprland', { devices: 2, readable: 0 })).toBeNull();
    expect(clickAccessHint('x11', { devices: 2, readable: 0 })).toBeNull();
  });
});
