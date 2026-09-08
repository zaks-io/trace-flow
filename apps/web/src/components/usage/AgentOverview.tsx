'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Bot } from 'lucide-react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { StatTile } from '@/components/agents/StatTile';
import { computeDelta } from '@/components/agents/delta';
import { getFreshFirstRow } from '@/components/agents/useAgentData';
import type { AgentSummaryRow } from '@/components/agents/types';
import { resolveAgentOverviewView, toAgentWindowParams } from './agentOverviewState';

/**
 * Coding-agent headline stats for the dashboard's selected time range. Renders nothing
 * for orgs without collector activity in the window; the LLM filters above do not apply
 * because agent data is not keyed by provider, proxy model, operation, or API key.
 */
export function AgentOverview({
  startTimeNs,
  endTimeNs,
}: {
  startTimeNs: number;
  endTimeNs: number;
}) {
  const params = useMemo(
    () => toAgentWindowParams({ startTimeNs, endTimeNs }),
    [startTimeNs, endTimeNs],
  );
  // Previous numbers stay on screen while a new range loads so the cards below do not jump.
  const summaryQuery = useTinybirdQuery<AgentSummaryRow>({
    pipe: 'agent_usage_summary',
    params,
    keepPreviousData: true,
  });
  const summary = getFreshFirstRow(summaryQuery);
  const view = resolveAgentOverviewView({
    isLoading: summaryQuery.isLoading,
    hasError: Boolean(summaryQuery.error),
    summary,
  });

  if (view === 'hidden') return null;

  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-medium text-foreground">Coding Agents</h2>
          <span className="text-xs text-muted-foreground">
            this time range; the filters above do not apply
          </span>
        </div>
        <Link href="/app/agents" className="text-sm text-primary hover:underline">
          View agent analytics
        </Link>
      </div>
      {view === 'error' || summary == null ? (
        <p className="text-sm text-red-400">
          Failed to load coding agent data. Please try refreshing.
        </p>
      ) : (
        <AgentOverviewTiles summary={summary} />
      )}
    </section>
  );
}

function AgentOverviewTiles({ summary }: { summary: AgentSummaryRow }) {
  const coverage = summary.coverage_pct == null ? null : formatPercent(summary.coverage_pct * 100);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatTile
        label="Cost (est.)"
        value={formatCurrency(summary.estimated_cost_usd)}
        sub={coverage ? `lower bound — ${coverage} of turns priced` : 'lower bound'}
        delta={computeDelta(summary.estimated_cost_usd, summary.prior_cost_usd)}
        invertDelta
      />
      <StatTile
        label="Tokens processed"
        value={formatNumber(summary.total_tokens)}
        sub="input + output + cache read + cache write"
        delta={computeDelta(summary.total_tokens, summary.prior_total_tokens)}
        invertDelta
      />
      <StatTile
        label="Conversations"
        value={formatNumber(summary.session_count)}
        delta={computeDelta(summary.session_count, summary.prior_session_count)}
      />
    </div>
  );
}
