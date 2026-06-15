'use client';

import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import { formatNumber } from '@/lib/format';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { BentoCell } from './BentoCell';
import { buildSizeHistogram } from './agentSessionSizes';
import type { AgentSessionSizeRow } from './types';

const CHART_CONFIG = {
  current: { label: 'Conversations', color: 'var(--color-chart-1)' },
  prior: { label: 'Previous period', color: 'var(--color-muted-foreground)' },
};

/**
 * Q4: how large are conversations? A histogram of conversations by message count, with the
 * median and p95 called out, and a faint prior-window twin so the shift in shape is visible.
 */
export function ConversationSizeHistogram({
  row,
  windowDays,
  expanded,
  onToggleExpand,
}: {
  row: AgentSessionSizeRow | null;
  windowDays: number;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const bins = useMemo(() => (row ? buildSizeHistogram(row) : []), [row]);
  const hasData = row != null && row.session_count > 0;

  return (
    <BentoCell
      title="Conversation size"
      hint="conversations by messages per session"
      expandable
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      caveat={`Bars are this window; the faint bars are the previous ${windowDays} days.`}
      expandedContent={
        hasData && row ? (
          <dl className="grid grid-cols-3 gap-3 text-xs">
            <Stat label="tokens / session (p50)" value={formatNumber(row.tokens_p50)} />
            <Stat label="tokens / session (p95)" value={formatNumber(row.tokens_p95)} />
            <Stat label="largest conversation" value={`${formatNumber(row.messages_max)} msgs`} />
          </dl>
        ) : null
      }
    >
      {hasData && row ? (
        <div>
          <div className="mb-2 flex items-baseline gap-4">
            <Headline label="median" value={`${formatNumber(row.messages_p50)} msgs`} />
            <Headline label="p95" value={`${formatNumber(row.messages_p95)} msgs`} />
          </div>
          <ChartContainer config={CHART_CONFIG} className="!aspect-auto h-[150px] w-full">
            <BarChart data={bins} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} tickMargin={6} />
              <YAxis tick={{ fontSize: 10 }} width={28} allowDecimals={false} />
              <ChartTooltip
                content={<ChartTooltipContent valueFormatter={(v) => formatNumber(Number(v))} />}
              />
              <Bar
                dataKey="prior"
                fill="var(--color-muted-foreground)"
                fillOpacity={0.18}
                radius={2}
              />
              <Bar dataKey="current" radius={2}>
                {bins.map((entry) => (
                  <Cell key={entry.label} fill="var(--color-chart-1)" />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        </div>
      ) : (
        <p className="flex h-[150px] items-center text-sm text-muted-foreground">
          No conversations in this range.
        </p>
      )}
    </BentoCell>
  );
}

function Headline({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="font-mono text-lg font-semibold tabular-nums text-foreground">{value}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-card/60 p-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}
