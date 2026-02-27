'use client';

import { useMemo, useState } from 'react';
import { parseSpanAttributes } from '@trace-flow/utils';

interface TraceSpan {
  SpanAttributes: string;
  Duration: number;
  Timestamp: number;
}

interface TokenSummaryCardsProps {
  spans: TraceSpan[];
}

interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
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
  };

  let minTimestamp = Infinity;
  let maxEndTimestamp = 0;

  for (const span of spans) {
    const attrs = parseSpanAttributes(span.SpanAttributes);

    const inputTokens = parseInt(attrs['gen_ai.usage.input_tokens'] ?? '0', 10);
    const outputTokens = parseInt(attrs['gen_ai.usage.output_tokens'] ?? '0', 10);
    const cacheRead = parseInt(attrs['gen_ai.usage.cache_read_input_tokens'] ?? '0', 10);
    const cacheWrite = parseInt(attrs['gen_ai.usage.cache_creation_input_tokens'] ?? '0', 10);
    const reasoning = parseInt(attrs['gen_ai.usage.reasoning_tokens'] ?? '0', 10);

    summary.tokens.input += Math.max(0, inputTokens - cacheRead - cacheWrite);
    summary.tokens.cacheRead += cacheRead;
    summary.tokens.cacheWrite += cacheWrite;
    summary.tokens.output += outputTokens;
    summary.tokens.reasoning += reasoning;

    if (attrs['gen_ai.cost.input']) summary.cost.input += parseFloat(attrs['gen_ai.cost.input']);
    if (attrs['gen_ai.cost.output']) summary.cost.output += parseFloat(attrs['gen_ai.cost.output']);
    if (attrs['gen_ai.cost.cache_read'])
      summary.cost.cacheRead += parseFloat(attrs['gen_ai.cost.cache_read']);
    if (attrs['gen_ai.cost.cache_creation'])
      summary.cost.cacheWrite += parseFloat(attrs['gen_ai.cost.cache_creation']);
    if (attrs['gen_ai.cost.reasoning'])
      summary.cost.reasoning += parseFloat(attrs['gen_ai.cost.reasoning']);

    if (attrs['gen_ai.tokens_per_second']) {
      const tps = parseFloat(attrs['gen_ai.tokens_per_second']);
      if (tps > 0) summary.tpsSpans.push({ tps, outputTokens });
    }
    if (attrs['gen_ai.server.time_to_first_token']) {
      const ttft = parseFloat(attrs['gen_ai.server.time_to_first_token']);
      if (ttft > 0) {
        summary.ttftValues.push(ttft);
        if (summary.ttftMs === null) summary.ttftMs = ttft;
      }
    }

    minTimestamp = Math.min(minTimestamp, span.Timestamp);
    maxEndTimestamp = Math.max(maxEndTimestamp, span.Timestamp + span.Duration);
  }

  summary.totalDuration = spans.length > 0 ? maxEndTimestamp - minTimestamp : 0;
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

function formatCompact(n: number): string {
  if (n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatCostCompact(dollars: number): string {
  if (dollars === 0) return '$0';
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  if (dollars >= 0.01) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(4)}`;
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

// ── BarCard: SummaryCard-shaped card with a thin stacked bar ──

interface InlineLabel {
  label: string;
  value: string;
  color: string;
}

interface BarCardProps {
  label: string;
  value: string;
  segments: Segment[];
  total: number;
  accent: string;
  formatter: (n: number) => string;
  inlineLabels?: InlineLabel[];
  showPercent?: boolean;
}

function BarCard({
  label,
  value,
  segments,
  total,
  accent,
  formatter,
  inlineLabels,
  showPercent = true,
}: BarCardProps) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const hoveredSeg = hoveredKey ? segments.find((s) => s.key === hoveredKey) : null;

  return (
    <div className={`relative min-w-0 overflow-hidden rounded-xl bg-linear-to-br p-5 ${accent}`}>
      <div>
        <p className="text-xs font-medium tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-2 font-mono text-3xl font-medium tabular-nums text-foreground">{value}</p>
      </div>
      {segments.length > 0 && total > 0 && (
        <>
          <div className="relative mt-3">
            {hoveredSeg && (
              <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-3 py-1.5 text-xs shadow-lg">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-sm"
                    style={{ backgroundColor: hoveredSeg.color }}
                  />
                  <span className="font-medium text-foreground">{hoveredSeg.label}</span>
                </div>
                {showPercent && (
                  <div className="mt-0.5 font-mono tabular-nums text-muted-foreground">
                    {formatter(hoveredSeg.value)} · {((hoveredSeg.value / total) * 100).toFixed(1)}%
                  </div>
                )}
              </div>
            )}
            <div className="flex h-1.5 w-full overflow-hidden rounded-full">
              {segments.map((seg) => {
                const pct = (seg.value / total) * 100;
                const isHovered = hoveredKey === seg.key;

                return (
                  <div
                    key={seg.key}
                    className="h-full transition-opacity duration-150"
                    style={{
                      flexBasis: `${pct}%`,
                      flexShrink: 0,
                      backgroundColor: seg.color,
                      opacity: hoveredKey && !isHovered ? 0.4 : 0.7,
                    }}
                    onMouseEnter={() => setHoveredKey(seg.key)}
                    onMouseLeave={() => setHoveredKey(null)}
                  />
                );
              })}
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5">
            {(
              inlineLabels ??
              segments
                .filter((seg) => seg.value > 0 && seg.color !== 'transparent')
                .map((seg) => ({
                  label: seg.label,
                  value: formatter(seg.value),
                  color: seg.color,
                }))
            ).map((item) => (
              <span
                key={item.label}
                className="flex items-center gap-1 text-[10px] text-muted-foreground"
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: item.color, opacity: 0.7 }}
                />
                <span className="font-mono tabular-nums">{item.value}</span>
                <span>{item.label}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
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
  );
}
