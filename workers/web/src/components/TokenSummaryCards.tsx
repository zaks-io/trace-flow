import { useMemo } from 'react';
import { parseSpanAttributes } from '@trace-flow/utils';
import { Cpu, MessageSquare, Hash, Zap, Clock, Activity, DollarSign, Target } from 'lucide-react';
import {
  calculateCacheHitRate,
  formatCacheHitRate,
  getCacheHitRateAccent,
} from '@/lib/cacheMetrics';
import { SummaryCard } from '@/components/usage/SummaryCard';

interface TraceSpan {
  SpanAttributes: string;
  Duration: number;
  Timestamp: number;
}

interface TokenSummaryCardsProps {
  spans: TraceSpan[];
}

interface TokenSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number | null;
  ttftMs: number | null;
  totalDuration: number;
  tokensPerSecond: number | null;
  totalCost: number;
}

function aggregateTokens(spans: TraceSpan[]): TokenSummary {
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let totalCost = 0;
  let ttftMs: number | null = null;
  let tokensPerSecond: number | null = null;
  let minTimestamp = Infinity;
  let maxEndTimestamp = 0;

  for (const span of spans) {
    const attrs = parseSpanAttributes(span.SpanAttributes);

    const prompt = parseInt(attrs['gen_ai.usage.input_tokens'] ?? '0', 10);
    const completion = parseInt(attrs['gen_ai.usage.output_tokens'] ?? '0', 10);
    const cacheRead = parseInt(attrs['gen_ai.usage.cache_read_input_tokens'] ?? '0', 10);
    const cacheCreation = parseInt(attrs['gen_ai.usage.cache_creation_input_tokens'] ?? '0', 10);

    promptTokens += prompt;
    completionTokens += completion;
    cacheReadTokens += cacheRead;
    cacheCreationTokens += cacheCreation;

    if (attrs['gen_ai.cost.total']) {
      totalCost += parseFloat(attrs['gen_ai.cost.total']);
    }

    // Use pre-calculated TPS from span attribute (first one found)
    if (attrs['gen_ai.tokens_per_second'] && tokensPerSecond === null) {
      tokensPerSecond = parseFloat(attrs['gen_ai.tokens_per_second']);
    }

    if (attrs['gen_ai.server.time_to_first_token'] && ttftMs === null) {
      ttftMs = parseFloat(attrs['gen_ai.server.time_to_first_token']);
    }

    minTimestamp = Math.min(minTimestamp, span.Timestamp);
    maxEndTimestamp = Math.max(maxEndTimestamp, span.Timestamp + span.Duration);
  }

  const totalDuration = spans.length > 0 ? maxEndTimestamp - minTimestamp : 0;
  const cacheHitRate = calculateCacheHitRate(cacheReadTokens, cacheCreationTokens, promptTokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRate,
    ttftMs,
    totalDuration,
    tokensPerSecond,
    totalCost,
  };
}

function formatNumber(num: number): string {
  return new Intl.NumberFormat().format(num);
}

function formatDuration(nanoseconds: number): string {
  const ms = nanoseconds / 1_000_000;
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatMilliseconds(ms: number): string {
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTokensPerSecond(tokensPerSec: number): string {
  if (tokensPerSec >= 1000) {
    return `${(tokensPerSec / 1000).toFixed(1)}k/s`;
  }
  return `${tokensPerSec.toFixed(1)}/s`;
}

function formatCost(dollars: number): string {
  if (dollars < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  if (dollars < 1) {
    return `$${dollars.toFixed(3)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

export function TokenSummaryCards({ spans }: TokenSummaryCardsProps) {
  const summary = useMemo(() => aggregateTokens(spans), [spans]);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
      <SummaryCard
        icon={<Cpu className="h-4 w-4" />}
        label="Prompt Tokens"
        value={summary.promptTokens > 0 ? formatNumber(summary.promptTokens) : '-'}
        accent="purple"
      />
      <SummaryCard
        icon={<MessageSquare className="h-4 w-4" />}
        label="Completion"
        value={summary.completionTokens > 0 ? formatNumber(summary.completionTokens) : '-'}
        accent="blue"
      />
      <SummaryCard
        icon={<Hash className="h-4 w-4" />}
        label="Total Tokens"
        value={summary.totalTokens > 0 ? formatNumber(summary.totalTokens) : '-'}
        accent="emerald"
      />
      <SummaryCard
        icon={<Target className="h-4 w-4" />}
        label="Cache Hit Rate"
        value={formatCacheHitRate(summary.cacheHitRate)}
        accent={getCacheHitRateAccent(summary.cacheHitRate)}
      />
      <SummaryCard
        icon={<Zap className="h-4 w-4" />}
        label="TTFT"
        value={summary.ttftMs !== null ? formatMilliseconds(summary.ttftMs) : '-'}
        accent="amber"
      />
      <SummaryCard
        icon={<Clock className="h-4 w-4" />}
        label="Duration"
        value={summary.totalDuration > 0 ? formatDuration(summary.totalDuration) : '-'}
        accent="zinc"
      />
      <SummaryCard
        icon={<Activity className="h-4 w-4" />}
        label="Tokens/sec"
        value={
          summary.tokensPerSecond !== null ? formatTokensPerSecond(summary.tokensPerSecond) : '-'
        }
        accent="blue"
      />
      <SummaryCard
        icon={<DollarSign className="h-4 w-4" />}
        label="Cost"
        value={summary.totalCost > 0 ? formatCost(summary.totalCost) : '-'}
        accent="green"
      />
    </div>
  );
}
