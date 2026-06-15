'use client';

import { useMemo, useState } from 'react';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AgentUsageChart } from './AgentUsageChart';
import { AnomalyStrip } from './AnomalyStrip';
import { BentoCell } from './BentoCell';
import { ConversationSizeHistogram } from './ConversationSizeHistogram';
import { CostProjectionHero } from './CostProjectionHero';
import { ContextDistributionCell } from './ContextDistributionCell';
import { SpendConcentrationDetail } from './SpendConcentrationDetail';
import { StatTile } from './StatTile';
import { VelocityBar } from './VelocityBar';
import { buildAttentionSignals } from './buildAttentionSignals';
import { buildBurnRateStats, hasUsableBurnRateBuckets, type BurnRateStats } from './burnRate';
import { computeDelta } from './delta';
import { generatedTokenShare } from './agentSessionSizes';
import { AGENT_GROUP_BY, AGENT_GROUP_BY_LABEL, type AgentGroupBy } from './types';
import type {
  AgentContextHealthRow,
  AgentCostDistributionRow,
  AgentNotableChangeRow,
  AgentSessionRow,
  AgentSummaryRow,
  AgentTimeseriesRow,
  FailureLeaderboardRow,
  ToolDeltaRow,
} from './types';

/** Only one drill-down is open at a time, except the always-present notable-changes strip. */
type ExpandableCell = 'hero' | 'conversationSize' | 'spendConcentration';

export function AgentBentoGrid({
  summary,
  burnSeries,
  priorBurnSeries,
  groupedSeries,
  groupBy,
  onGroupByChange,
  costDistribution,
  topSessions,
  topSessionsLoading,
  onSpendDetailToggle,
  notableTotal,
  notableByRepo,
  contextHealth,
  failures,
  deltas,
  filterParams,
  timezone,
  attentionThresholdTokens,
  windowDays,
  labelFor,
}: {
  summary: AgentSummaryRow;
  burnSeries: AgentTimeseriesRow[];
  priorBurnSeries: AgentTimeseriesRow[];
  /** Time-series fetched with the active `groupBy`; powers the hero drill-down split. */
  groupedSeries: AgentTimeseriesRow[];
  groupBy: AgentGroupBy;
  onGroupByChange: (next: AgentGroupBy) => void;
  costDistribution: AgentCostDistributionRow | null;
  /** Priciest conversations behind the spend curve; fetched only while that cell is expanded. */
  topSessions: AgentSessionRow[];
  topSessionsLoading: boolean;
  /** Lifts the spend-cell open state up so its drill-down fetch runs only while visible. */
  onSpendDetailToggle: (open: boolean) => void;
  notableTotal: AgentNotableChangeRow | null;
  notableByRepo: AgentNotableChangeRow[];
  contextHealth: AgentContextHealthRow | null;
  failures: FailureLeaderboardRow[];
  deltas: ToolDeltaRow[];
  filterParams: Record<string, string | number>;
  timezone: string;
  attentionThresholdTokens: number;
  windowDays: number;
  labelFor: (value: string) => string;
}) {
  const [expanded, setExpanded] = useState<ExpandableCell | null>(null);
  const [anomalyOpen, setAnomalyOpen] = useState(false);
  // The hero drill-down re-groups cost by source/model/repo, which only the fetch can do
  // (the resting series is ungrouped). Default to 'source' on open; reset on collapse so
  // the grouped query only runs while the drill-down is visible.
  const heroGroupBy: AgentGroupBy = groupBy === 'none' ? 'source' : groupBy;
  // Single place that keeps both expand-gated fetches in sync with which cell is open: the
  // grouped time-series runs only while the hero is open, and the priciest-conversations fetch
  // only while the spend cell is open. Opening any other cell tears both down so no invisible
  // query lingers.
  const setExpandedCell = (next: ExpandableCell | null) => {
    setExpanded(next);
    onGroupByChange(next === 'hero' ? heroGroupBy : 'none');
    onSpendDetailToggle(next === 'spendConcentration');
  };
  const toggle = (cell: ExpandableCell) => setExpandedCell(expanded === cell ? null : cell);
  const toggleHero = () => toggle('hero');

  const stats: BurnRateStats | null = useMemo(() => {
    if (!hasUsableBurnRateBuckets(burnSeries, timezone)) return null;
    return buildBurnRateStats({
      summary,
      currentRows: burnSeries,
      priorRows: priorBurnSeries,
      filterParams,
      timezone,
    });
  }, [summary, burnSeries, priorBurnSeries, filterParams, timezone]);

  const signals = useMemo(
    () =>
      buildAttentionSignals({
        summary,
        contextHealth,
        notableTotal,
        failures,
        attentionThresholdTokens,
      }),
    [summary, contextHealth, notableTotal, failures, attentionThresholdTokens],
  );

  const tokensDelta = computeDelta(summary.total_tokens, summary.prior_total_tokens);
  const sessionsDelta = computeDelta(summary.session_count, summary.prior_session_count);
  const generatedShare = costDistribution ? generatedTokenShare(costDistribution) : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-6 xl:grid-cols-12">
      {/* Row 1 — Q1 cost + projection hero (Q2 cost delta fused) + 3 Q2 tiles */}
      <BentoCell
        title="Cost over time"
        hint={`estimated daily cost and a ${windowDays}-day projection`}
        className="lg:col-span-6 xl:col-span-8"
        expandable
        expanded={expanded === 'hero'}
        onToggleExpand={toggleHero}
        toolbar={
          expanded === 'hero' ? (
            <GroupByToggle value={heroGroupBy} onChange={onGroupByChange} />
          ) : undefined
        }
        caveat="Projection is a naive linear run-rate (no model). The band spans calendar-day to active-day pace."
        expandedContent={
          <div>
            <p className="mb-2 text-xs text-muted-foreground">
              Estimated cost over time, grouped by {AGENT_GROUP_BY_LABEL[heroGroupBy].toLowerCase()}
              .
            </p>
            <AgentUsageChart
              data={groupedSeries}
              metric="cost"
              groupBy={heroGroupBy}
              granularity="day"
              chartStyle="stacked"
              labelFor={labelFor}
            />
          </div>
        }
      >
        <CostProjectionHero
          summary={summary}
          burnSeries={burnSeries}
          stats={stats}
          windowDays={windowDays}
        />
      </BentoCell>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:col-span-6 lg:grid-cols-1 xl:col-span-4">
        <StatTile
          label="Tokens processed"
          value={formatNumber(summary.total_tokens)}
          sub={
            generatedShare != null
              ? `${Math.round(generatedShare * 100)}% generated, rest is cache read`
              : 'input + output + cache read + cache write'
          }
          delta={tokensDelta}
          invertDelta
        />
        <StatTile
          label="Conversations"
          value={formatNumber(summary.session_count)}
          sub={
            stats
              ? `${formatNumber(Math.round(stats.sessionsPerActiveDay * 10) / 10)} / active day`
              : undefined
          }
          delta={sessionsDelta}
        />
        <StatTile
          label="Active days"
          value={stats ? formatNumber(stats.activeDays) : '—'}
          sub={
            stats
              ? `of ${formatNumber(Math.round(stats.calendarDays))} in range`
              : 'needs daily buckets'
          }
        />
      </div>

      {/* Row 2 — Q4 cost-per-conversation distribution + Q3 per-turn context distribution */}
      <div className="lg:col-span-6 xl:col-span-6">
        <ConversationSizeHistogram
          row={costDistribution}
          windowDays={windowDays}
          expanded={expanded === 'conversationSize'}
          onToggleExpand={() => toggle('conversationSize')}
        />
      </div>
      <div className="lg:col-span-6 xl:col-span-6">
        <ContextDistributionCell row={contextHealth} windowDays={windowDays} />
      </div>

      {/* Row 3 — Q5 where spend concentrates */}
      <div className="lg:col-span-6 xl:col-span-12">
        <VelocityBar
          row={costDistribution}
          windowDays={windowDays}
          expanded={expanded === 'spendConcentration'}
          onToggleExpand={() => toggle('spendConcentration')}
          expandedContent={
            <SpendConcentrationDetail
              sessions={topSessions}
              loading={topSessionsLoading}
              labelFor={labelFor}
            />
          }
        />
      </div>

      {/* Row 4 — Q6 notable changes, always present */}
      <div className="lg:col-span-6 xl:col-span-12">
        <AnomalyStrip
          signals={signals}
          notableTotal={notableTotal}
          notableByRepo={notableByRepo}
          deltas={deltas}
          failures={failures}
          windowDays={windowDays}
          labelFor={labelFor}
          expanded={anomalyOpen}
          onToggleExpand={() => setAnomalyOpen((open) => !open)}
        />
      </div>
    </div>
  );
}

function GroupByToggle({
  value,
  onChange,
}: {
  value: AgentGroupBy;
  onChange: (next: AgentGroupBy) => void;
}) {
  return (
    <div className="flex rounded-lg border border-border/60">
      {AGENT_GROUP_BY.filter((g) => g !== 'none').map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={cn(
            'px-2 py-1 text-[11px] font-medium transition-colors first:rounded-l-lg last:rounded-r-lg',
            value === option
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {AGENT_GROUP_BY_LABEL[option]}
        </button>
      ))}
    </div>
  );
}
