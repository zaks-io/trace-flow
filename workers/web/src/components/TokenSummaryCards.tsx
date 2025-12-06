import { useMemo } from 'react';
import { Cpu, MessageSquare, Hash, Zap, Clock } from 'lucide-react';

interface TraceSpan {
  SpanAttributes: string;
  Duration: number;
}

interface TokenSummaryCardsProps {
  spans: TraceSpan[];
}

interface TokenSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  ttftMs: number | null;
  totalDuration: number;
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
  let ttftMs: number | null = null;
  let totalDuration = 0;

  for (const span of spans) {
    const attrs = parseAttributes(span.SpanAttributes);

    const prompt =
      parseInt(attrs['ai.tokens.prompt'] ?? '0', 10) ||
      parseInt(attrs['ai.tokens.input'] ?? '0', 10) ||
      parseInt(attrs['gen_ai.usage.input_tokens'] ?? '0', 10);

    const completion =
      parseInt(attrs['ai.tokens.completion'] ?? '0', 10) ||
      parseInt(attrs['ai.tokens.output'] ?? '0', 10) ||
      parseInt(attrs['gen_ai.usage.output_tokens'] ?? '0', 10);

    promptTokens += prompt;
    completionTokens += completion;

    if (attrs['ai.time_to_first_token_ms'] && ttftMs === null) {
      ttftMs = parseFloat(attrs['ai.time_to_first_token_ms']);
    }

    if (span.Duration > totalDuration) {
      totalDuration = span.Duration;
    }
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ttftMs,
    totalDuration,
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

interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: 'purple' | 'blue' | 'emerald' | 'amber' | 'zinc';
}

function SummaryCard({ icon, label, value, accent = 'zinc' }: SummaryCardProps) {
  const accentColors = {
    purple: 'from-purple-500/20 to-purple-500/5 border-purple-500/30',
    blue: 'from-blue-500/20 to-blue-500/5 border-blue-500/30',
    emerald: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30',
    amber: 'from-amber-500/20 to-amber-500/5 border-amber-500/30',
    zinc: 'from-zinc-500/20 to-zinc-500/5 border-zinc-500/30',
  };

  const iconColors = {
    purple: 'text-purple-400',
    blue: 'text-blue-400',
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    zinc: 'text-zinc-400',
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

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
    </div>
  );
}
