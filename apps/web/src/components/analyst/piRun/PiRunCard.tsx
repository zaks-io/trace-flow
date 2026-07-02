'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAction, useQuery } from 'convex/react';
import { api } from '@trace-flow/convex/_generated/api';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  CLIENT_RUN_TIMEOUT_GRACE_MS,
  clientTimeoutDeadlineMs,
  isActive,
  isFinalRunEventDuplicate,
  latestRunActivity,
  withClientDerivedTimeout,
  type SandboxRun,
  type SandboxRunEvent,
} from '../piRunEvents';
import type { PiRunRow } from '@trace-flow/convex/analystPiRows';
import { PiToolRow } from './PiToolRow';
import { PiTextRow } from './PiTextRow';
import { PiRunRowShell } from './PiRunRowShell';

/**
 * The analysis run rendered inline as part of the parent agent's turn — no card,
 * no header, no run metadata. Its tool/text rows continue the parent timeline rail
 * and its composed answer renders as the assistant's reply, so the whole thing reads
 * as one seamless agent call.
 */
export function PiRunCard({
  run,
  resumed,
}: {
  run: SandboxRun;
  toolState?: string;
  resumed?: boolean;
}) {
  const events = useQuery(api.analystSandbox.listSandboxRunEvents, {
    runId: run._id,
    limit: 100,
  }) as SandboxRunEvent[] | undefined;
  const serverRows = useQuery(api.analystSandbox.listSandboxRunRows, {
    runId: run._id,
    limit: 200,
  }) as PiRunRow[] | undefined;
  const cancelRun = useAction(api.analystSandbox.cancelSandboxRun);
  const refreshRunStatus = useAction(api.analystSandbox.refreshSandboxRunStatus);
  const shouldRefreshStatus = isActive(run.status) || Boolean(run.needsStatusRefresh);
  const now = useNowWhileActive(shouldRefreshStatus);
  const refreshKeyRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);
  const displayRun = withClientDerivedTimeout(run, events, now);
  const active = isActive(displayRun.status);
  const refreshDeadline = clientTimeoutDeadlineMs(run, events) + CLIENT_RUN_TIMEOUT_GRACE_MS;
  const activity = latestRunActivity(displayRun, events, now);
  const rows = useMemo(
    () => (serverRows ?? []).filter((row) => !isFinalRunEventDuplicate(displayRun, row)),
    [serverRows, displayRun],
  );
  const latestRowKey = rows.at(-1)?.key;

  useEffect(() => {
    if (!shouldRefreshStatus) {
      refreshKeyRef.current = null;
      return;
    }
    if (!run.needsStatusRefresh && now < refreshDeadline) return;

    const refreshKey = `${run._id}:${refreshDeadline}`;
    if (refreshKeyRef.current === refreshKey) return;
    refreshKeyRef.current = refreshKey;
    void refreshRunStatus({ runId: run._id }).catch(() => {
      refreshKeyRef.current = null;
    });
  }, [
    now,
    refreshDeadline,
    refreshRunStatus,
    run._id,
    run.needsStatusRefresh,
    shouldRefreshStatus,
  ]);

  // Keep the transcript pinned to the newest activity unless the user has scrolled
  // up to read earlier steps. Pin after paint so the new row's height is measured.
  useEffect(() => {
    const element = transcriptRef.current;
    if (!element || pinnedToBottomRef.current === false) return;
    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [latestRowKey, rows.length, displayRun.status]);

  return (
    <div className="space-y-2 text-sm">
      {(rows.length > 0 || active) && (
        <div className="rounded-lg border border-border/60 bg-background/40">
          <div className="flex items-center justify-between border-b border-border/50 px-2.5 py-1.5">
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Work log
              {resumed && (
                <span className="rounded-full bg-chart-1/15 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-chart-1">
                  Resumed
                </span>
              )}
            </span>
            {active && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void cancelRun({ runId: displayRun._id })}
                aria-label="Stop analysis"
              >
                Stop
              </Button>
            )}
          </div>
          <div
            ref={transcriptRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            className="max-h-64 space-y-1 overflow-y-auto px-2.5 py-2"
          >
            {rows.length > 0 ? (
              rows.map((row) => <PiRunRowView key={row.key} row={row} />)
            ) : (
              <p className="text-xs text-muted-foreground">
                {serverRows === undefined ? 'Loading…' : activity?.latestToolName || 'Working…'}
              </p>
            )}
          </div>
        </div>
      )}

      {/* The composed answer is rendered by the assistant's own message below — the
          card is just the work log, so we don't duplicate the result here. */}
      {displayRun.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs leading-relaxed text-destructive">
          {displayRun.error}
        </div>
      )}
    </div>
  );
}

function PiRunRowView({ row }: { row: PiRunRow }) {
  switch (row.kind) {
    case 'tool':
      return <PiToolRow row={row} />;
    case 'text':
      return <PiTextRow text={row.text} />;
    case 'note':
      return (
        <PiRunRowShell icon={<Info className="h-3.5 w-3.5 text-muted-foreground" />}>
          <div className="flex items-baseline gap-1.5 text-[11px]">
            <span
              className={cn(
                'font-medium',
                row.tone === 'danger' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {row.label}
            </span>
            <span className="min-w-0 text-foreground/80">{row.text}</span>
          </div>
        </PiRunRowShell>
      );
  }
}

function useNowWhileActive(active: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active]);

  return active ? now : Date.now();
}
