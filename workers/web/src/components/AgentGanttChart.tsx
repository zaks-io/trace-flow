import { useMemo, useRef, useState, useLayoutEffect } from 'react';
import {
  Bot,
  Zap,
  Activity,
  Settings2,
  User,
  MessageCircle,
  ArrowLeftRight,
  FileText,
  Brain,
  Send,
  Play,
} from 'lucide-react';

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

type SpanType =
  | 'llm' // AI request (infrastructure - muted)
  | 'ttft' // Time to first token (infrastructure - muted)
  | 'system' // System message (input)
  | 'user' // User message (input)
  | 'assistant_input' // Prior assistant message (input)
  | 'tool_result' // Tool result (input)
  | 'assistant_text' // Assistant text output
  | 'assistant_thinking' // Thinking/reasoning output
  | 'assistant_tool_use' // Tool use request (output)
  | 'tool_execution' // Cross-request tool execution
  | 'internal'; // Fallback

interface SpanRow {
  span: TraceSpan;
  depth: number;
  startOffset: number;
  width: number;
  type: SpanType;
  tokens: number | null;
  tokensPerSecond: number | null;
  messageIndex: number | null;
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

  // Infrastructure spans (muted)
  if (name === 'ai.request' || name.includes('chat/completions')) return 'llm';
  if (name === 'ai.request.ttft' || name.includes('ttft')) return 'ttft';

  // Input message spans (warm tones)
  if (name === 'ai.system.message') return 'system';
  if (name === 'ai.user.message') return 'user';
  if (name === 'ai.assistant.message') return 'assistant_input';
  if (name === 'ai.tool.result') return 'tool_result';

  // Output spans (cool/vibrant tones)
  if (name.startsWith('ai.assistant.text')) return 'assistant_text';
  if (name.startsWith('ai.assistant.thinking')) return 'assistant_thinking';
  if (name.startsWith('ai.assistant.tool_use')) return 'assistant_tool_use';

  // Tool execution
  if (name === 'ai.tool.execution') return 'tool_execution';

  // Fallback for other assistant outputs (numbered variants like ai.assistant.text.2)
  if (name.startsWith('ai.assistant.')) return 'assistant_text';

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

function getMessageIndex(span: TraceSpan): number | null {
  const attrs = parseAttributes(span.SpanAttributes);
  const index = attrs['ai.message.index'];
  return index !== undefined ? parseInt(index, 10) : null;
}

function isHollowType(type: SpanType): boolean {
  return type === 'llm' || type === 'ttft';
}

function getTypeColor(type: SpanType, status: string): string {
  if (status === 'ERROR') return 'bg-red-500';

  switch (type) {
    // Infrastructure - hollow style (handled separately in JSX)
    case 'llm':
      return 'border-violet-400 bg-violet-500/10';
    case 'ttft':
      return 'border-rose-400 bg-rose-500/10';

    // Input messages - warm/earth tones
    case 'system':
      return 'bg-slate-500';
    case 'user':
      return 'bg-emerald-500';
    case 'assistant_input':
      return 'bg-sky-400';
    case 'tool_result':
      return 'bg-amber-500';

    // Output spans - cool/vibrant tones
    case 'assistant_text':
      return 'bg-indigo-500';
    case 'assistant_thinking':
      return 'bg-violet-500';
    case 'assistant_tool_use':
      return 'bg-cyan-500';

    // Tool execution - accent
    case 'tool_execution':
      return 'bg-orange-500';

    default:
      return 'bg-zinc-500';
  }
}

function getTypeIcon(type: SpanType) {
  switch (type) {
    // Infrastructure
    case 'llm':
      return <Bot className="h-3.5 w-3.5" />;
    case 'ttft':
      return <Zap className="h-3.5 w-3.5" />;

    // Input messages
    case 'system':
      return <Settings2 className="h-3.5 w-3.5" />;
    case 'user':
      return <User className="h-3.5 w-3.5" />;
    case 'assistant_input':
      return <MessageCircle className="h-3.5 w-3.5" />;
    case 'tool_result':
      return <ArrowLeftRight className="h-3.5 w-3.5" />;

    // Output spans
    case 'assistant_text':
      return <FileText className="h-3.5 w-3.5" />;
    case 'assistant_thinking':
      return <Brain className="h-3.5 w-3.5" />;
    case 'assistant_tool_use':
      return <Send className="h-3.5 w-3.5" />;

    // Tool execution
    case 'tool_execution':
      return <Play className="h-3.5 w-3.5" />;

    default:
      return <Activity className="h-3.5 w-3.5" />;
  }
}

function getTypeIconColor(type: SpanType): string {
  switch (type) {
    // Infrastructure - colored to match hollow bars
    case 'llm':
      return 'text-violet-400';
    case 'ttft':
      return 'text-rose-400';

    // Input messages - warm tones
    case 'system':
      return 'text-slate-400';
    case 'user':
      return 'text-emerald-400';
    case 'assistant_input':
      return 'text-sky-400';
    case 'tool_result':
      return 'text-amber-400';

    // Output spans - cool/vibrant
    case 'assistant_text':
      return 'text-indigo-400';
    case 'assistant_thinking':
      return 'text-violet-400';
    case 'assistant_tool_use':
      return 'text-cyan-400';

    // Tool execution
    case 'tool_execution':
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
          messageIndex: getMessageIndex(traceRoot),
        });

        // Build children for this trace's root
        const buildSpanTree = (parentId: string, depth: number): SpanRow[] => {
          const children = traceSpans
            .filter((s) => s.ParentSpanId === parentId)
            .sort((a, b) => {
              // Primary: sort by timestamp
              const timeDiff = a.Timestamp - b.Timestamp;
              if (timeDiff !== 0) return timeDiff;
              // Secondary: sort by ai.message.index for spans with same timestamp
              const aIndex = getMessageIndex(a);
              const bIndex = getMessageIndex(b);
              if (aIndex !== null && bIndex !== null) return aIndex - bIndex;
              if (aIndex !== null) return -1;
              if (bIndex !== null) return 1;
              return 0;
            });

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
              messageIndex: getMessageIndex(span),
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
        .sort((a, b) => {
          // Primary: sort by timestamp
          const timeDiff = a.Timestamp - b.Timestamp;
          if (timeDiff !== 0) return timeDiff;
          // Secondary: sort by ai.message.index for spans with same timestamp
          const aIndex = getMessageIndex(a);
          const bIndex = getMessageIndex(b);
          if (aIndex !== null && bIndex !== null) return aIndex - bIndex;
          if (aIndex !== null) return -1;
          if (bIndex !== null) return 1;
          return 0;
        });

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
          messageIndex: getMessageIndex(span),
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
        messageIndex: getMessageIndex(rootSpan),
      });

      allRows.push(...buildSpanTree(rootSpan.SpanId, 1));
    }

    return { spanRows: allRows, totalDuration: total, traceStartTime: traceStart };
  }, [spans]);

  // Refs for measuring bar positions
  const containerRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Flow paths calculated from measured bar positions
  const [flowPaths, setFlowPaths] = useState<string[]>([]);

  // Measure bar positions after render and generate flow paths
  useLayoutEffect(() => {
    if (!containerRef.current || spanRows.length < 2) {
      setFlowPaths([]);
      return;
    }

    const containerRect = containerRef.current.getBoundingClientRect();

    // Group spans by parent ai.request (index resets per request)
    const spansByParent = new Map<string, SpanRow[]>();
    for (const row of spanRows) {
      if (row.messageIndex !== null) {
        const parent = row.span.ParentSpanId;
        const group = spansByParent.get(parent) ?? [];
        group.push(row);
        spansByParent.set(parent, group);
      }
    }

    // Sort each group by messageIndex
    for (const group of spansByParent.values()) {
      group.sort((a, b) => a.messageIndex! - b.messageIndex!);
    }

    // Sort groups by the timestamp of their first span
    const sortedGroups = [...spansByParent.values()].sort(
      (a, b) => a[0].span.Timestamp - b[0].span.Timestamp,
    );

    // Helper to create bezier path between two bars
    const createPath = (current: SpanRow, next: SpanRow): string | null => {
      const currentBar = barRefs.current.get(current.span.SpanId);
      const nextBar = barRefs.current.get(next.span.SpanId);

      if (!currentBar || !nextBar) return null;

      const currentRect = currentBar.getBoundingClientRect();
      const nextRect = nextBar.getBoundingClientRect();

      const fromX = currentRect.right - containerRect.left;
      const toX = nextRect.left - containerRect.left;
      // Connect from bottom of source to top of target
      const fromY = currentRect.bottom - containerRect.top;
      const toY = nextRect.top - containerRect.top;

      const horizontalDist = Math.abs(toX - fromX);
      const verticalDist = Math.abs(toY - fromY);

      // For stacked spans (close horizontally), just draw a straight line
      if (horizontalDist < 50) {
        return `M ${fromX} ${fromY} L ${toX} ${toY}`;
      }

      // For horizontally spread spans, use smooth S-curve
      const controlX1 = fromX + horizontalDist * 0.3;
      const controlX2 = toX - horizontalDist * 0.3;
      const curveStrength = Math.max(verticalDist * 0.4, 30);

      return `M ${fromX} ${fromY} C ${controlX1} ${fromY + curveStrength}, ${controlX2} ${toY - curveStrength}, ${toX} ${toY}`;
    };

    const paths: string[] = [];

    // Connect spans within each group, then between groups
    for (let g = 0; g < sortedGroups.length; g++) {
      const group = sortedGroups[g];

      // Connect within group
      for (let i = 0; i < group.length - 1; i++) {
        const path = createPath(group[i], group[i + 1]);
        if (path) paths.push(path);
      }

      // Connect to next group (last of this group to first of next)
      if (g < sortedGroups.length - 1) {
        const nextGroup = sortedGroups[g + 1];
        const path = createPath(group[group.length - 1], nextGroup[0]);
        if (path) paths.push(path);
      }
    }

    setFlowPaths(paths);
  }, [spanRows]);

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

      <div ref={containerRef} className="relative">
        {/* Flow lines SVG overlay - behind spans with muted gray */}
        {flowPaths.length > 0 && (
          <svg className="pointer-events-none absolute inset-0 z-10 overflow-visible">
            {flowPaths.map((path, i) => (
              <path
                key={i}
                d={path}
                fill="none"
                stroke="rgb(82 82 91 / 0.7)"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            ))}
          </svg>
        )}
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
                  ref={(el) => {
                    if (el && row.messageIndex !== null) {
                      barRefs.current.set(row.span.SpanId, el);
                    }
                  }}
                  className={`absolute h-full rounded transition-opacity group-hover:opacity-90 ${isHollowType(row.type) ? 'border' : ''} ${getTypeColor(row.type, row.span.StatusCode)}`}
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
