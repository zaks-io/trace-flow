'use client';

import { CheckCircle2, CircleDashed, MinusCircle } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AgentSourceStatusItem, AgentSourceStatusState } from './sourceStatus';

const STATE_LABEL: Record<AgentSourceStatusState, string> = {
  synced: 'Synced',
  not_connected: 'Not connected',
  unsupported: 'Unsupported',
};

const STATE_STYLE: Record<AgentSourceStatusState, string> = {
  synced: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  not_connected: 'border-border bg-card text-muted-foreground',
  unsupported: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
};

export function AgentSourceStatusPanel({ items }: { items: AgentSourceStatusItem[] }) {
  return (
    <section
      aria-label="Collector sources"
      className="mb-6 rounded-xl border border-border/60 bg-card/30 p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Collector sources</h2>
          <p className="text-xs text-muted-foreground">
            Server-ingested sync metadata by source. Cursor is not a supported source yet.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {items.map((item) => (
          <SourceStatusCard key={item.source} item={item} />
        ))}
      </div>
    </section>
  );
}

function SourceStatusCard({ item }: { item: AgentSourceStatusItem }) {
  const synced = item.state === 'synced';
  const hasDistinctIngestedTime = item.lastIngestedMs !== item.lastSuccessfulSyncMs;

  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium capitalize text-foreground">{item.source}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{statusDetail(item)}</p>
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
            STATE_STYLE[item.state],
          )}
        >
          <StatusIcon state={item.state} />
          {STATE_LABEL[item.state]}
        </span>
      </div>
      {synced && (
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">
              {hasDistinctIngestedTime ? 'Last sync' : 'Last sync / ingest'}
            </dt>
            <dd className="mt-0.5 font-medium text-foreground">
              {formatTimestampMs(item.lastSuccessfulSyncMs)}
            </dd>
          </div>
          {hasDistinctIngestedTime ? (
            <div>
              <dt className="text-muted-foreground">Last ingested</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {formatTimestampMs(item.lastIngestedMs)}
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-muted-foreground">Sessions</dt>
            <dd className="mt-0.5 font-mono text-foreground">{formatNumber(item.sessionCount)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Messages</dt>
            <dd className="mt-0.5 font-mono text-foreground">{formatNumber(item.messageCount)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function StatusIcon({ state }: { state: AgentSourceStatusState }) {
  if (state === 'synced') return <CheckCircle2 className="h-3 w-3" />;
  if (state === 'unsupported') return <MinusCircle className="h-3 w-3" />;
  return <CircleDashed className="h-3 w-3" />;
}

function statusDetail(item: AgentSourceStatusItem): string {
  if (item.state === 'unsupported') return 'Awaiting explicit Cursor ingestion support.';
  if (item.state === 'not_connected') return 'No successful CLI sync seen for this source.';

  const collectors =
    item.collectorCount === 1 ? '1 collector' : `${formatNumber(item.collectorCount)} collectors`;
  const tools = item.toolEventCount > 0 ? `, ${formatNumber(item.toolEventCount)} tool events` : '';
  return `${collectors}${tools}`;
}

function formatTimestampMs(value: number | null): string {
  if (!value) return 'Unknown';
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
