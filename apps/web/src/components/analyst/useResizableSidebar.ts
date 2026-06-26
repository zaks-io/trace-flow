'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'trace-flow:analyst-sidebar-width';
const MIN_WIDTH = 360;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 420;
const KEYBOARD_STEP = 24;

function clampWidth(value: number) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

function readStoredWidth() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/**
 * Drag/keyboard resize for the Analyst sidebar. The handle sits on the left edge,
 * so dragging left widens the panel. Width is clamped and persisted to localStorage,
 * mirroring the open-state persistence in AnalystContext.
 */
export function useResizableSidebar() {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    setWidth(readStoredWidth());
  }, []);

  const persist = useCallback((next: number) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Width still applies for this session if storage is unavailable.
    }
  }, []);

  const applyWidth = useCallback(
    (next: number) => {
      const clamped = clampWidth(next);
      setWidth(clamped);
      persist(clamped);
    },
    [persist],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      setResizing(true);
      event.currentTarget.setPointerCapture(event.pointerId);

      const handleMove = (moveEvent: PointerEvent) => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => {
          setWidth(clampWidth(startWidth + (startX - moveEvent.clientX)));
        });
      };

      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        setResizing(false);
        setWidth((current) => {
          persist(current);
          return current;
        });
      };

      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
    },
    [persist, width],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        applyWidth(width + KEYBOARD_STEP);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        applyWidth(width - KEYBOARD_STEP);
      }
    },
    [applyWidth, width],
  );

  return {
    width,
    resizing,
    handleProps: {
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      'aria-label': 'Resize Analyst panel',
      'aria-valuenow': width,
      'aria-valuemin': MIN_WIDTH,
      'aria-valuemax': MAX_WIDTH,
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
    },
  };
}
