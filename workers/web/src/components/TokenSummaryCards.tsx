import { useMemo } from 'react';
import { Cpu, MessageSquare, Hash, Zap, Clock, Activity, DollarSign, Database } from 'lucide-react';

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
  ttftMs: number | null;
  totalDuration: number;
  tokensPerSecond: number | null;
  totalCost: number;
}

function parseAttributes(attributesJson: string): Record<string, string> {
  try {
    return JSON.parse(attributesJson) as Record<string, string>;
  } catch {
    return {};
  }
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
    const attrs = parseAttributes(span.SpanAttributes);

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

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheReadTokens,
    cacheCreationTokens,
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

function calculateCacheHitRate(cacheRead: number, cacheCreation: number): number | null {
  const totalCacheable = cacheRead + cacheCreation;
  if (totalCacheable === 0) return null;
  return (cacheRead / totalCacheable) * 100;
}

function formatCacheHitRate(rate: number | null): string {
  if (rate === null) return '-';
  return `${rate.toFixed(1)}%`;
}

interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: 'purple' | 'blue' | 'emerald' | 'amber' | 'zinc' | 'green';
}

function SummaryCard({ icon, label, value, accent = 'zinc' }: SummaryCardProps) {
  const accentColors = {
    purple: 'from-purple-500/20 to-purple-500/5 border-purple-500/30',
    blue: 'from-blue-500/20 to-blue-500/5 border-blue-500/30',
    emerald: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30',
    amber: 'from-amber-500/20 to-amber-500/5 border-amber-500/30',
    zinc: 'from-zinc-500/20 to-zinc-500/5 border-zinc-500/30',
    green: 'from-green-500/20 to-green-500/5 border-green-500/30',
  };

  const iconColors = {
    purple: 'text-purple-400',
    blue: 'text-blue-400',
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    zinc: 'text-zinc-400',
    green: 'text-green-400',
  };

  return (
    <div
      className={`relative overflow-hidden rounded-xl border bg-gradient-to-br p-4 ${accentColors[accent]}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
            {value}
          </p>
        </div>
        <div className={`rounded-lg bg-background/50 p-2 ${iconColors[accent]}`}>{icon}</div>
      </div>
    </div>
  );
}

export function TokenSummaryCards({ spans }: TokenSummaryCardsProps) {
  const summary = useMemo(() => aggregateTokens(spans), [spans]);
  const cacheHitRate = useMemo(
    () => calculateCacheHitRate(summary.cacheReadTokens, summary.cacheCreationTokens),
    [summary.cacheReadTokens, summary.cacheCreationTokens],
  );

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
        icon={<Database className="h-4 w-4" />}
        label="Cache Hit Rate"
        value={formatCacheHitRate(cacheHitRate)}
        accent="green"
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
