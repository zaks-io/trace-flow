'use client';

import { useMemo } from 'react';
import { parseSpanAttributes, type TraceSpanRow } from '@trace-flow/spans';
import { GEN_AI, GEN_AI_COST, GEN_AI_USAGE } from '@trace-flow/otel-conventions';
import {
  BarCard,
  type Segment,
  formatCompact,
  formatCostCompact,
} from '@/components/shared/BarCard';
import { formatModelDisplay } from '@/lib/format';

type TraceSpan = Pick<TraceSpanRow, 'SpanAttributes' | 'Duration' | 'Timestamp'>;

interface TokenSummaryCardsProps {
  spans: TraceSpan[];
}

interface AggregatedSummary {
  tokens: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
  };
  cost: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
  };
  ttftMs: number | null;
  ttftValues: number[];
  totalDuration: number;
  tpsSpans: { tps: number; outputTokens: number }[];
  models: string[];
}

const SEGMENT_CONFIG = {
  input: { label: 'Input', color: 'var(--color-chart-4)' },
  cacheRead: { label: 'Cache Read', color: 'var(--color-chart-3)' },
  cacheWrite: { label: 'Cache Write', color: 'var(--color-chart-2)' },
  output: { label: 'Output', color: 'var(--color-chart-1)' },
  reasoning: { label: 'Reasoning', color: 'var(--color-chart-5)' },
} as const;

type SegmentKey = keyof typeof SEGMENT_CONFIG;

const SEGMENT_ORDER: SegmentKey[] = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'];

function aggregateSummary(spans: TraceSpan[]): AggregatedSummary {
  const summary: AggregatedSummary = {
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    ttftMs: null,
    ttftValues: [],
    totalDuration: 0,
    tpsSpans: [],
    models: [],
  };

  const modelCosts = new Map<string, number>();
  let minTimestamp = Infinity;
  let maxEndTimestamp = 0;

  for (const span of spans) {
    const attrs = parseSpanAttributes(span.SpanAttributes);

    const inputTokens = parseInt(attrs[GEN_AI_USAGE.INPUT_TOKENS] ?? '0', 10);
    const uncachedInputTokens = parseInt(attrs[GEN_AI_USAGE.INPUT_TOKENS_UNCACHED] ?? '0', 10);
    const outputTokens = parseInt(attrs[GEN_AI_USAGE.OUTPUT_TOKENS] ?? '0', 10);
    const cacheRead = parseInt(attrs[GEN_AI_USAGE.CACHE_READ_INPUT_TOKENS] ?? '0', 10);
    const cacheWrite = parseInt(attrs[GEN_AI_USAGE.CACHE_CREATION_INPUT_TOKENS] ?? '0', 10);
    const reasoning = parseInt(attrs[GEN_AI_USAGE.REASONING_TOKENS] ?? '0', 10);

    summary.tokens.input +=
      uncachedInputTokens > 0
        ? uncachedInputTokens
        : Math.max(0, inputTokens - cacheRead - cacheWrite);
    summary.tokens.cacheRead += cacheRead;
    summary.tokens.cacheWrite += cacheWrite;
    summary.tokens.output += outputTokens;
    summary.tokens.reasoning += reasoning;

    let spanCost = 0;
    if (attrs[GEN_AI_COST.INPUT]) {
      const v = parseFloat(attrs[GEN_AI_COST.INPUT]);
      summary.cost.input += v;
      spanCost += v;
    }
    if (attrs[GEN_AI_COST.OUTPUT]) {
      const v = parseFloat(attrs[GEN_AI_COST.OUTPUT]);
      summary.cost.output += v;
      spanCost += v;
    }
    if (attrs[GEN_AI_COST.CACHE_READ]) {
      const v = parseFloat(attrs[GEN_AI_COST.CACHE_READ]);
      summary.cost.cacheRead += v;
      spanCost += v;
    }
    if (attrs[GEN_AI_COST.CACHE_CREATION]) {
      const v = parseFloat(attrs[GEN_AI_COST.CACHE_CREATION]);
      summary.cost.cacheWrite += v;
      spanCost += v;
    }
    if (attrs[GEN_AI_COST.REASONING]) {
      const v = parseFloat(attrs[GEN_AI_COST.REASONING]);
      summary.cost.reasoning += v;
      spanCost += v;
    }

    if (attrs[GEN_AI.TOKENS_PER_SECOND]) {
      const tps = parseFloat(attrs[GEN_AI.TOKENS_PER_SECOND]);
      if (tps > 0) summary.tpsSpans.push({ tps, outputTokens });
    }
    if (attrs[GEN_AI.SERVER_TTFT]) {
      const ttft = parseFloat(attrs[GEN_AI.SERVER_TTFT]);
      if (ttft > 0) {
        summary.ttftValues.push(ttft);
        if (summary.ttftMs === null) summary.ttftMs = ttft;
      }
    }

    const rawModel = attrs[GEN_AI.REQUEST_MODEL];
    if (rawModel) {
      const display = formatModelDisplay(rawModel, attrs[GEN_AI.SYSTEM]);
      modelCosts.set(display, (modelCosts.get(display) ?? 0) + spanCost);
    }

    minTimestamp = Math.min(minTimestamp, span.Timestamp);
    maxEndTimestamp = Math.max(maxEndTimestamp, span.Timestamp + span.Duration);
  }

  summary.totalDuration = spans.length > 0 ? maxEndTimestamp - minTimestamp : 0;
  summary.models = Array.from(modelCosts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([model]) => model);
  return summary;
}

function buildSegments(values: Record<SegmentKey, number>): Segment[] {
  return SEGMENT_ORDER.filter((key) => values[key] > 0).map((key) => ({
    key,
    label: SEGMENT_CONFIG[key].label,
    value: values[key],
    color: SEGMENT_CONFIG[key].color,
  }));
}

function formatDuration(nanoseconds: number): string {
  const ms = nanoseconds / 1_000_000;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTokensPerSecond(tokensPerSec: number): string {
  if (tokensPerSec >= 1000) return `${(tokensPerSec / 1000).toFixed(1)}k/s`;
  return `${tokensPerSec.toFixed(1)}/s`;
}

function buildDurationSegments(ttftMs: number | null, totalDurationNs: number): Segment[] {
  if (ttftMs === null || totalDurationNs <= 0) return [];
  const ttftNs = ttftMs * 1_000_000;
  const genNs = Math.max(0, totalDurationNs - ttftNs);
  return [
    { key: 'ttft', label: 'TTFT', value: ttftNs, color: 'var(--color-chart-2)' },
    { key: 'generation', label: 'Generation', value: genNs, color: 'var(--color-chart-8)' },
  ];
}

// Below 1 stddev = slow (red), within 1 stddev = normal (ochre), above 1 stddev = fast (cerulean)
function tpsColor(t: number, avg: number, stddev: number): string {
  if (stddev === 0) return 'var(--color-chart-4)';
  if (t < avg - stddev) return 'var(--color-chart-1)';
  if (t > avg + stddev) return 'var(--color-chart-4)';
  return 'var(--color-chart-2)';
}

function buildThroughputSegments(tpsSpans: { tps: number; outputTokens: number }[]): {
  segments: Segment[];
  total: number;
  min: number;
  avg: number;
  max: number;
  stddev: number;
} | null {
  if (tpsSpans.length === 0) return null;
  const tpsValues = tpsSpans.map((s) => s.tps);
  const min = Math.min(...tpsValues);
  const max = Math.max(...tpsValues);
  const totalTokens = tpsSpans.reduce((a, b) => a + b.outputTokens, 0);
  const totalTime = tpsSpans.reduce((a, s) => a + s.outputTokens / s.tps, 0);
  const avg = totalTime > 0 ? totalTokens / totalTime : 0;
  const stddev = Math.sqrt(
    tpsValues.reduce((sum, v) => sum + (v - avg) ** 2, 0) / tpsValues.length,
  );

  // Sort slow→fast, sized by output tokens so width = impact
  const sorted = [...tpsSpans].sort((a, b) => a.tps - b.tps);
  const total = sorted.reduce((a, b) => a + b.outputTokens, 0);
  const segments: Segment[] = sorted.map((s, i) => ({
    key: `tps-${i}`,
    label: `${formatTokensPerSecond(s.tps)} · ${formatCompact(s.outputTokens)} tokens`,
    value: s.outputTokens,
    color: tpsColor(s.tps, avg, stddev),
  }));

  return { segments, total, min, avg, max, stddev };
}

export function TokenSummaryCards({ spans }: TokenSummaryCardsProps) {
  const summary = useMemo(() => aggregateSummary(spans), [spans]);

  const totalTokens = useMemo(
    () => Object.values(summary.tokens).reduce((a, b) => a + b, 0),
    [summary.tokens],
  );
  const totalCost = useMemo(
    () => Object.values(summary.cost).reduce((a, b) => a + b, 0),
    [summary.cost],
  );
  const tokenSegments = useMemo(() => buildSegments(summary.tokens), [summary.tokens]);
  const costSegments = useMemo(() => buildSegments(summary.cost), [summary.cost]);
  const durationSegments = useMemo(
    () => buildDurationSegments(summary.ttftMs, summary.totalDuration),
    [summary.ttftMs, summary.totalDuration],
  );
  const throughput = useMemo(() => buildThroughputSegments(summary.tpsSpans), [summary.tpsSpans]);

  const hasCost = totalCost > 0;
  const gridCols = hasCost ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-3';

  return (
    <div className="space-y-3">
      <div className={`grid min-w-0 gap-3 ${gridCols}`}>
        <BarCard
          label="Tokens"
          value={totalTokens > 0 ? formatCompact(totalTokens) : '-'}
          segments={tokenSegments}
          total={totalTokens}
          accent="from-chart-3/20 to-chart-3/5"
          formatter={formatCompact}
        />
        {hasCost && (
          <BarCard
            label="Cost"
            value={formatCostCompact(totalCost)}
            segments={costSegments}
            total={totalCost}
            accent="from-chart-7/20 to-chart-7/5"
            formatter={formatCostCompact}
          />
        )}
        <BarCard
          label="Duration"
          value={summary.totalDuration > 0 ? formatDuration(summary.totalDuration) : '-'}
          segments={durationSegments}
          total={summary.totalDuration}
          accent="from-chart-2/20 to-chart-2/5"
          formatter={formatDuration}
        />
        <BarCard
          label="Throughput"
          value={throughput ? formatTokensPerSecond(throughput.avg) : '-'}
          segments={throughput?.segments ?? []}
          total={throughput?.total ?? 0}
          accent="from-chart-4/20 to-chart-4/5"
          formatter={formatTokensPerSecond}
          showPercent={false}
          inlineLabels={
            throughput
              ? [
                  {
                    label: 'Min',
                    value: formatTokensPerSecond(throughput.min),
                    color: tpsColor(throughput.min, throughput.avg, throughput.stddev),
                  },
                  {
                    label: 'Avg',
                    value: formatTokensPerSecond(throughput.avg),
                    color: 'var(--color-chart-2)',
                  },
                  {
                    label: 'Max',
                    value: formatTokensPerSecond(throughput.max),
                    color: tpsColor(throughput.max, throughput.avg, throughput.stddev),
                  },
                  {
                    label: 'σ',
                    value: formatTokensPerSecond(throughput.stddev),
                    color: 'var(--color-muted-foreground)',
                  },
                ]
              : undefined
          }
        />
      </div>
      {summary.models.length > 0 && (
        <div className="flex items-baseline gap-2 rounded-xl bg-linear-to-br from-chart-5/20 to-chart-5/5 px-5 py-3">
          <span className="shrink-0 text-xs font-medium tracking-wide text-muted-foreground">
            Models
          </span>
          <span className="font-mono text-xs text-foreground">{summary.models.join(' · ')}</span>
        </div>
      )}
    </div>
  );
}
