'use client';

import { useCallback, useEffect, useState } from 'react';

const KEY_PREFIX = 'agents:section:';

/**
 * Open/closed state for a collapsible section, persisted to localStorage so a user's choice
 * survives reloads. SSR-safe: renders from `defaultOpen` on the server and first client paint,
 * then hydrates the stored value in an effect to avoid a hydration mismatch.
 */
export function useSectionOpen(
  storageKey: string | undefined,
  defaultOpen: boolean,
): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(KEY_PREFIX + storageKey);
    if (stored === 'true' || stored === 'false') setOpen(stored === 'true');
  }, [storageKey]);

  const setAndPersist = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (storageKey && typeof window !== 'undefined') {
        window.localStorage.setItem(KEY_PREFIX + storageKey, String(next));
      }
    },
    [storageKey],
  );

  return [open, setAndPersist];
}
