/**
 * useSpritesheets
 *
 * The timeline's thumbnail sheets, and the fact that they show up late.
 *
 * Generating a sheet is a full decode pass of the recording, so it runs behind
 * the editor rather than in front of it. That means there are two ways to learn
 * about a sheet and a caller needs both: ask once on mount for whatever already
 * exists (a reopened project usually has its sheets on disk), and then listen,
 * because a fresh recording's sheets land seconds later.
 *
 * An empty result is therefore not the same as "this project has no
 * thumbnails". It means "not yet", and the lanes are expected to look
 * deliberate while they wait.
 */

import { useEffect, useState } from 'react';

import type { SpritesheetsBySource } from '@/types';

const NO_SHEETS: SpritesheetsBySource = {};

export function useSpritesheets(): SpritesheetsBySource {
  const [sheets, setSheets] = useState<SpritesheetsBySource>(NO_SHEETS);

  useEffect(() => {
    const editor = window.electron?.editor;
    if (!editor) {
      return;
    }

    let cancelled = false;

    void editor
      .getSpritesheets()
      .then((initial) => {
        // The subscription below may already have delivered a newer set while
        // this promise was in flight, so a late-arriving initial fetch must not
        // clobber it. Losing the race is the common case on a fresh recording.
        if (!cancelled) {
          setSheets((current) =>
            Object.keys(current).length > 0 ? current : (initial ?? NO_SHEETS),
          );
        }
      })
      .catch(() => {
        // No sheets is a supported state, not an error worth surfacing.
      });

    const unsubscribe = editor.onSpritesheetsUpdated((next) => {
      if (!cancelled) {
        setSheets(next ?? NO_SHEETS);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return sheets;
}
