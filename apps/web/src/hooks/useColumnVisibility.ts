import { useState, useCallback, useEffect } from 'react';
import type { VisibilityState } from '@tanstack/react-table';

const DEFAULT_STORAGE_KEY = 'trace-flow-requests-columns';

export function useColumnVisibility(
  defaultVisibility: VisibilityState,
  storageKey: string = DEFAULT_STORAGE_KEY,
) {
  const [visibility, setVisibility] = useState<VisibilityState>(defaultVisibility);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        // Columns added after the preference was saved start at their defaults.
        setVisibility({ ...defaultVisibility, ...(JSON.parse(stored) as VisibilityState) });
      } catch {
        // Ignore parse errors, use defaults
      }
    }
    setIsHydrated(true);
  }, [defaultVisibility, storageKey]);

  const updateVisibility = useCallback(
    (updater: VisibilityState | ((prev: VisibilityState) => VisibilityState)) => {
      setVisibility((prev) => {
        const newState = typeof updater === 'function' ? updater(prev) : updater;
        localStorage.setItem(storageKey, JSON.stringify(newState));
        return newState;
      });
    },
    [storageKey],
  );

  const resetToDefaults = useCallback(() => {
    setVisibility(defaultVisibility);
    localStorage.setItem(storageKey, JSON.stringify(defaultVisibility));
  }, [defaultVisibility, storageKey]);

  return {
    visibility: isHydrated ? visibility : defaultVisibility,
    setVisibility: updateVisibility,
    resetToDefaults,
    isHydrated,
  };
}
