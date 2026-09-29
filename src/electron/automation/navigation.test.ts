import { describe, expect, it, vi } from 'vitest';

import { PendingNavigation } from './navigation.js';

describe('PendingNavigation', () => {
  it('nudges on each request and hands the newest one out once', () => {
    const nudge = vi.fn();
    const navigation = new PendingNavigation(nudge);
    expect(navigation.take()).toBeNull();

    navigation.request({ screen: 'recorder' });
    navigation.request({ screen: 'editor', projectDir: '/p' });
    expect(nudge).toHaveBeenCalledTimes(2);
    expect(navigation.take()).toEqual({ screen: 'editor', projectDir: '/p' });
    expect(navigation.take()).toBeNull();
  });
});
