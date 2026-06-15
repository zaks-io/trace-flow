'use client';

import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AttentionSignal } from './buildAttentionSignals';

const SEVERITY_CLASS: Record<AttentionSignal['severity'], string> = {
  critical: 'border-red-500/30 bg-red-500/10 text-red-400',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
};

/**
 * The "what should I worry about" strip: a row of compact alert chips, critical-first. When
 * nothing crosses a threshold it stays a single calm muted line — never a celebration banner.
 */
export function AttentionCallout({ signals }: { signals: AttentionSignal[] }) {
  if (signals.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5" />
        No attention signals for this window
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {signals.map((signal) => (
        <div
          key={signal.id}
          title={signal.detail}
          className={cn(
            'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium',
            SEVERITY_CLASS[signal.severity],
          )}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {signal.label}
        </div>
      ))}
    </div>
  );
}
