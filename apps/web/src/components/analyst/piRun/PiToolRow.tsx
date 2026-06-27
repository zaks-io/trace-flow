'use client';

import { useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PiRunRow } from '../piRunEvents';
import { getPiToolConfig, formatPiToolLabel } from '../piToolConfig';
import { PiRunRowShell } from './PiRunRowShell';

type ToolRow = Extract<PiRunRow, { kind: 'tool' }>;

export function PiToolRow({ row }: { row: ToolRow }) {
  const config = getPiToolConfig(row.toolName);
  const Icon = config.icon;
  const hasOutput = Boolean(row.output);
  const [open, setOpen] = useState(false);

  const statusIcon = row.isError ? (
    <AlertCircle className="h-3.5 w-3.5 text-destructive" />
  ) : (
    <Icon className={cn('h-3.5 w-3.5', config.accent)} />
  );

  return (
    <PiRunRowShell icon={statusIcon}>
      <button
        type="button"
        disabled={!hasOutput}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex w-full items-center gap-1.5 text-left text-xs',
          hasOutput && 'cursor-pointer',
        )}
      >
        <span
          className={cn('font-medium', row.isError ? 'text-destructive' : 'text-foreground/80')}
        >
          {formatPiToolLabel(row.toolName, row.command)}
        </span>
        {!row.isError && !hasOutput && (
          <CheckCircle2 className="h-3 w-3 text-muted-foreground/60" />
        )}
        {hasOutput && (
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
        )}
      </button>

      {open && row.output && (
        <pre
          className={cn(
            'mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border px-2 py-1 font-mono text-[11px] leading-relaxed',
            row.isError
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-border/60 bg-muted/40 text-foreground/90',
          )}
        >
          {row.output}
        </pre>
      )}
    </PiRunRowShell>
  );
}
