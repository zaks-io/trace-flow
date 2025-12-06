import { useMemo } from 'react';
import { Bot, Zap, MessageSquare, Wrench, Activity } from 'lucide-react';

interface TraceSpan {
  Timestamp: number;
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  SpanName: string;
  ServiceName: string;
  Duration: number;
  StatusCode: string;
  SpanAttributes: string;
}

interface AgentGanttChartProps {
  spans: TraceSpan[];
  selectedSpanId?: string;
  onSpanSelect?: (spanId: string) => void;
  parentSpanId?: string;
}

type SpanType = 'llm' | 'ttft' | 'message' | 'tool' | 'internal';

interface SpanRow {
  span: TraceSpan;
  depth: number;
  startOffset: number;
  width: number;
  type: SpanType;
  tokens: number | null;
  tokensPerSecond: number | null;
}

function parseAttributes(attributesJson: string): Record<string, string> {
  try {
    return JSON.parse(attributesJson) as Record<string, string>;
  } catch {
    return {};
  }
}

function getSpanType(span: TraceSpan): SpanType {
  const name = span.SpanName.toLowerCase();

  if (name === 'ai.request' || name.includes('chat/completions')) return 'llm';
  if (name === 'ai.request.ttft' || name.includes('ttft')) return 'ttft';
  if (name.startsWith('ai.assistant.') || name.includes('message')) return 'message';
  if (name.includes('tool')) return 'tool';

  return 'internal';
}

function getSpanTokens(span: TraceSpan): number | null {
  const attrs = parseAttributes(span.SpanAttributes);
  const total =
    parseInt(attrs['ai.tokens.total'] ?? '0', 10) ||
    parseInt(attrs['ai.usage.total_tokens'] ?? '0', 10) ||
    parseInt(attrs['gen_ai.usage.input_tokens'] ?? '0', 10) +
      parseInt(attrs['gen_ai.usage.output_tokens'] ?? '0', 10);

  return total > 0 ? total : null;
}

function getSpanTokensPerSecond(span: TraceSpan): number | null {
  const attrs = parseAttributes(span.SpanAttributes);
  const completion =
    parseInt(attrs['ai.tokens.completion'] ?? '0', 10) ||
    parseInt(attrs['ai.tokens.output'] ?? '0', 10) ||
    parseInt(attrs['gen_ai.usage.output_tokens'] ?? '0', 10);

  const durationSeconds = span.Duration / 1_000_000_000;
  return durationSeconds > 0 && completion > 0 ? completion / durationSeconds : null;
}

function getTypeColor(type: SpanType, status: string): string {
  if (status === 'ERROR') return 'bg-red-500';

  switch (type) {
    case 'llm':
      return 'bg-purple-500';
    case 'ttft':
      return 'bg-amber-500';
    case 'message':
      return 'bg-blue-500';
    case 'tool':
      return 'bg-orange-500';
    default:
      return 'bg-zinc-500';
  }
}

function getTypeIcon(type: SpanType) {
  switch (type) {
    case 'llm':
      return <Bot className="h-3.5 w-3.5" />;
    case 'ttft':
      return <Zap className="h-3.5 w-3.5" />;
    case 'message':
      return <MessageSquare className="h-3.5 w-3.5" />;
    case 'tool':
      return <Wrench className="h-3.5 w-3.5" />;
    default:
      return <Activity className="h-3.5 w-3.5" />;
  }
}

function getTypeIconColor(type: SpanType): string {
  switch (type) {
    case 'llm':
      return 'text-purple-400';
    case 'ttft':
      return 'text-amber-400';
    case 'message':
      return 'text-blue-400';
    case 'tool':
      return 'text-orange-400';
    default:
      return 'text-zinc-400';
  }
}

function formatDuration(nanoseconds: number): string {
  const ms = nanoseconds / 1_000_000;
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}μs`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatNumber(num: number): string {
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}k`;
  }
  return num.toString();
}

export function AgentGanttChart({
  spans,
  selectedSpanId,
  onSpanSelect,
  parentSpanId,
}: AgentGanttChartProps) {
  const { spanRows, totalDuration } = useMemo(() => {
    if (spans.length === 0) return { spanRows: [], totalDuration: 0, traceStartTime: 0 };

    // Check if this is a span group (multiple traces without a true root span)
    const uniqueTraceIds = [...new Set(spans.map((s) => s.TraceId))];
    const hasRootSpan = spans.some((s) => s.ParentSpanId === '');
    const isSpanGroup = uniqueTraceIds.length > 1 || (!hasRootSpan && spans.length > 0);

    if (isSpanGroup) {
      // Multi-trace mode: group by TraceId and render each trace's root span at depth 0
      const traceGroups = new Map<string, TraceSpan[]>();
      for (const span of spans) {
        const group = traceGroups.get(span.TraceId) ?? [];
        group.push(span);
        traceGroups.set(span.TraceId, group);
      }

      const traceStart = Math.min(...spans.map((s) => s.Timestamp));
      const traceEndTime = Math.max(...spans.map((s) => s.Timestamp + s.Duration));
      const total = traceEndTime - traceStart;

      const allRows: SpanRow[] = [];

      // Sort trace groups by their earliest timestamp
      const sortedTraceGroups = [...traceGroups.entries()].sort((a, b) => {
        const aMin = Math.min(...a[1].map((s) => s.Timestamp));
        const bMin = Math.min(...b[1].map((s) => s.Timestamp));
        return aMin - bMin;
      });

      for (const [, traceSpans] of sortedTraceGroups) {
        // Find root of this trace (span whose parent is not in this trace's span set)
        const traceSpanIds = new Set(traceSpans.map((s) => s.SpanId));
        const traceRoot = traceSpans.find((s) => !traceSpanIds.has(s.ParentSpanId));
        if (!traceRoot) continue;

        const rootType = getSpanType(traceRoot);
        const rootTokens = getSpanTokens(traceRoot);
        const rootTps = getSpanTokensPerSecond(traceRoot);
        const startOffset = ((traceRoot.Timestamp - traceStart) / total) * 100;
        const width = (traceRoot.Duration / total) * 100;

        allRows.push({
          span: traceRoot,
          depth: 0,
          startOffset,
          width: Math.max(width, 0.5),
          type: rootType,
          tokens: rootTokens,
          tokensPerSecond: rootTps,
        });

        // Build children for this trace's root
        const buildSpanTree = (parentId: string, depth: number): SpanRow[] => {
          const children = traceSpans
            .filter((s) => s.ParentSpanId === parentId)
            .sort((a, b) => a.Timestamp - b.Timestamp);

          const rows: SpanRow[] = [];
          for (const span of children) {
            const childStartOffset = ((span.Timestamp - traceStart) / total) * 100;
            const childWidth = (span.Duration / total) * 100;
            const type = getSpanType(span);
            const tokens = getSpanTokens(span);
            const tps = getSpanTokensPerSecond(span);

            rows.push({
              span,
              depth,
              startOffset: childStartOffset,
              width: Math.max(childWidth, 0.5),
              type,
              tokens,
              tokensPerSecond: tps,
            });

            rows.push(...buildSpanTree(span.SpanId, depth + 1));
          }
          return rows;
        };

        allRows.push(...buildSpanTree(traceRoot.SpanId, 1));
      }

      return { spanRows: allRows, totalDuration: total, traceStartTime: traceStart };
    }

    // Single trace mode: handle multiple root spans within the same TraceId
    const spanIds = new Set(spans.map((s) => s.SpanId));

    // Find ALL root spans (spans whose parent is not in the span set or is empty)
    const rootSpans = spans
      .filter((s) => s.ParentSpanId === '' || !spanIds.has(s.ParentSpanId))
      .sort((a, b) => a.Timestamp - b.Timestamp);

    // Fallback to earliest span if no roots found
    const effectiveRoots =
      rootSpans.length > 0
        ? rootSpans
        : [spans.reduce((a, b) => (a.Timestamp < b.Timestamp ? a : b))];

    const traceStart = Math.min(...effectiveRoots.map((s) => s.Timestamp));
    const traceEndTime = Math.max(...spans.map((s) => s.Timestamp + s.Duration));
    const total = traceEndTime - traceStart;

    const buildSpanTree = (parentId: string, depth = 0): SpanRow[] => {
      const children = spans
        .filter((s) => s.ParentSpanId === parentId)
        .sort((a, b) => a.Timestamp - b.Timestamp);

      const rows: SpanRow[] = [];

      for (const span of children) {
        const startOffset = ((span.Timestamp - traceStart) / total) * 100;
        const width = (span.Duration / total) * 100;
        const type = getSpanType(span);
        const tokens = getSpanTokens(span);
        const tps = getSpanTokensPerSecond(span);

        rows.push({
          span,
          depth,
          startOffset,
          width: Math.max(width, 0.5),
          type,
          tokens,
          tokensPerSecond: tps,
        });

        rows.push(...buildSpanTree(span.SpanId, depth + 1));
      }

      return rows;
    };

    // Build rows for ALL root spans and their children
    const allRows: SpanRow[] = [];
    for (const rootSpan of effectiveRoots) {
      const rootType = getSpanType(rootSpan);
      const rootTokens = getSpanTokens(rootSpan);
      const rootTps = getSpanTokensPerSecond(rootSpan);
      const startOffset = ((rootSpan.Timestamp - traceStart) / total) * 100;

      allRows.push({
        span: rootSpan,
        depth: 0,
        startOffset,
        width: Math.max((rootSpan.Duration / total) * 100, 0.5),
        type: rootType,
        tokens: rootTokens,
        tokensPerSecond: rootTps,
      });

      allRows.push(...buildSpanTree(rootSpan.SpanId, 1));
    }

    return { spanRows: allRows, totalDuration: total, traceStartTime: traceStart };
  }, [spans]);

  if (spanRows.length === 0) {
    return null;
  }

  const timeMarkers = [0, 0.25, 0.5, 0.75, 1].map((pct) => ({
    position: pct * 100,
    label: formatDuration(totalDuration * pct),
  }));

  return (
    <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
      <div className="flex border-b border-border/30 bg-muted/20">
        <div className="w-56 shrink-0 border-r border-border/30 px-4 py-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Span
          </span>
        </div>
        <div className="relative flex-1 px-4 py-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Timeline
          </span>
          <div className="absolute inset-x-4 bottom-0 flex justify-between">
            {timeMarkers.map((marker, i) => (
              <div
                key={i}
                className="absolute bottom-0 h-1.5 w-px bg-border/50"
                style={{ left: `${marker.position}%` }}
              />
            ))}
          </div>
        </div>
      </div>

      {parentSpanId && (
        <div className="flex border-b border-border/30 bg-muted/30">
          <div className="w-56 shrink-0 border-r border-border/30 px-4 py-2">
            <span className="text-xs text-muted-foreground">Parent Span</span>
          </div>
          <div className="relative flex-1 px-4 py-2">
            <div className="h-5 w-full rounded border border-dashed border-zinc-500/50 bg-zinc-600/50" />
          </div>
        </div>
      )}

      <div>
        {spanRows.map((row) => (
          <div
            key={row.span.SpanId}
            className={`group flex border-b border-border/20 transition-colors hover:bg-muted/30 ${
              selectedSpanId === row.span.SpanId ? 'bg-primary/5' : ''
            } ${onSpanSelect ? 'cursor-pointer' : ''}`}
            onClick={() => onSpanSelect?.(row.span.SpanId)}
          >
            <div
              className="flex w-56 shrink-0 items-center gap-2 border-r border-border/30 py-2 pr-2"
              style={{ paddingLeft: `${12 + row.depth * 16}px` }}
            >
              <span className={getTypeIconColor(row.type)}>{getTypeIcon(row.type)}</span>
              <span className="truncate text-xs text-foreground" title={row.span.SpanName}>
                {row.span.SpanName}
              </span>
            </div>

            <div className="relative flex-1 px-4 py-2">
              <div className="relative h-5">
                <div
                  className={`absolute h-full rounded transition-opacity group-hover:opacity-90 ${getTypeColor(row.type, row.span.StatusCode)}`}
                  style={{
                    left: `${row.startOffset}%`,
                    width: `${row.width}%`,
                    minWidth: '4px',
                  }}
                >
                  {row.tokens !== null && row.width > 8 && (
                    <span className="absolute inset-0 flex items-center justify-center text-[9px] font-medium text-white/90">
                      {formatNumber(row.tokens)}
                    </span>
                  )}
                </div>
              </div>

              <div className="pointer-events-none absolute left-4 top-1/2 z-10 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100">
                <div
                  className="whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-xs shadow-lg ring-1 ring-border/50"
                  style={{ marginLeft: `${row.startOffset}%` }}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{row.span.SpanName}</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatDuration(row.span.Duration)}
                    </span>
                    {row.tokens !== null && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatNumber(row.tokens)} tokens
                        </span>
                      </>
                    )}
                    {row.tokensPerSecond !== null && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span className="tabular-nums text-muted-foreground">
                          {row.tokensPerSecond.toFixed(1)} tok/s
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex border-t border-border/30 bg-muted/10">
        <div className="w-56 shrink-0 border-r border-border/30" />
        <div className="relative flex h-8 flex-1 justify-between px-4 py-3">
          {timeMarkers.map((marker, i) => (
            <span
              key={i}
              className="text-[10px] tabular-nums text-muted-foreground/70"
              style={{
                position: 'absolute',
                left: `calc(${marker.position}% + 1rem)`,
                transform: i === timeMarkers.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {marker.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
