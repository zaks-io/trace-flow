'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Id } from '@convex/_generated/dataModel';
import { pageContextKey, type AnalystPageContextReference } from './pageContext';

interface AnalystContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  currentThreadId: Id<'analystThreads'> | null;
  selectThread: (threadId: Id<'analystThreads'> | null) => void;
  selectionMode: boolean;
  setSelectionMode: (enabled: boolean) => void;
  selectedReferences: AnalystPageContextReference[];
  toggleReference: (reference: AnalystPageContextReference) => void;
  removeReference: (reference: AnalystPageContextReference) => void;
  clearReferences: () => void;
  isReferenceSelected: (reference: AnalystPageContextReference) => boolean;
}

const AnalystContext = createContext<AnalystContextValue | null>(null);
const ANALYST_OPEN_STORAGE_KEY = 'trace-flow:analyst-sidebar-open';

export function AnalystProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = useState(false);
  const [currentThreadId, setCurrentThreadId] = useState<Id<'analystThreads'> | null>(null);
  const [selectionModeState, setSelectionModeState] = useState(false);
  const [selectedReferences, setSelectedReferences] = useState<AnalystPageContextReference[]>([]);

  const clearReferences = useCallback(() => setSelectedReferences([]), []);

  useEffect(() => {
    setOpenState(readStoredOpenState());
  }, []);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      writeStoredOpenState(next);
      if (!next) {
        setSelectionModeState(false);
        clearReferences();
      }
    },
    [clearReferences],
  );

  const selectThread = useCallback(
    (threadId: Id<'analystThreads'> | null) => {
      setCurrentThreadId(threadId);
      clearReferences();
    },
    [clearReferences],
  );

  const setSelectionMode = useCallback((enabled: boolean) => {
    setSelectionModeState(enabled);
  }, []);

  const toggleReference = useCallback((reference: AnalystPageContextReference) => {
    setSelectedReferences((current) => {
      const key = pageContextKey(reference);
      if (current.some((item) => pageContextKey(item) === key)) {
        return current.filter((item) => pageContextKey(item) !== key);
      }
      return [...current, reference];
    });
  }, []);

  const removeReference = useCallback((reference: AnalystPageContextReference) => {
    setSelectedReferences((current) =>
      current.filter((item) => pageContextKey(item) !== pageContextKey(reference)),
    );
  }, []);

  const isReferenceSelected = useCallback(
    (reference: AnalystPageContextReference) =>
      selectedReferences.some((item) => pageContextKey(item) === pageContextKey(reference)),
    [selectedReferences],
  );

  const value = useMemo<AnalystContextValue>(
    () => ({
      open,
      setOpen,
      currentThreadId,
      selectThread,
      selectionMode: open && selectionModeState,
      setSelectionMode,
      selectedReferences,
      toggleReference,
      removeReference,
      clearReferences,
      isReferenceSelected,
    }),
    [
      open,
      setOpen,
      currentThreadId,
      selectThread,
      selectionModeState,
      setSelectionMode,
      selectedReferences,
      toggleReference,
      removeReference,
      clearReferences,
      isReferenceSelected,
    ],
  );

  return <AnalystContext.Provider value={value}>{children}</AnalystContext.Provider>;
}

export function useAnalyst() {
  const context = useContext(AnalystContext);
  if (!context) throw new Error('useAnalyst must be used within AnalystProvider');
  return context;
}

export function useOptionalAnalyst() {
  return useContext(AnalystContext);
}

function readStoredOpenState() {
  try {
    return window.localStorage.getItem(ANALYST_OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStoredOpenState(open: boolean) {
  try {
    window.localStorage.setItem(ANALYST_OPEN_STORAGE_KEY, open ? '1' : '0');
  } catch {
    // Ignore unavailable storage; visibility still works for the current session.
  }
}
