import { useMemo, useState, useRef, useEffect } from 'react';
import {
  Bot,
  Activity,
  Settings2,
  User,
  MessageCircle,
  ArrowLeftRight,
  FileText,
  Brain,
  Send,
  Play,
  ChevronRight,
  ChevronDown,
  ChevronsUpDown,
  AlertTriangle,
  AlertCircle,
  Info,
  Layers,
} from 'lucide-react';
import type { TraceAlertSummary, AlertSeverity } from '@/types/alerts';

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
  spanAlertSummary?: Map<string, TraceAlertSummary>;
}

const alertSeverityStyles: Record<
  AlertSeverity,
  { edge: string; glow: string; icon: React.ElementType; text: string }
> = {
  info: {
    edge: 'bg-blue-500',
    glow: 'shadow-[0_0_8px_rgba(59,130,246,0.4)]',
    icon: Info,
    text: 'text-blue-400',
  },
  warning: {
    edge: 'bg-amber-500',
    glow: 'shadow-[0_0_10px_rgba(245,158,11,0.5)]',
    icon: AlertTriangle,
    text: 'text-amber-400',
  },
  error: {
    edge: 'bg-red-500',
    glow: 'shadow-[0_0_12px_rgba(239,68,68,0.6)]',
    icon: AlertCircle,
    text: 'text-red-400',
  },
};

type SpanType =
  | 'llm' // AI request (infrastructure - muted)
  | 'system' // System message (input)
  | 'user' // User message (input)
  | 'assistant_input' // Prior assistant message (input)
  | 'tool_result' // Tool result (input)
  | 'assistant_text' // Assistant text output
  | 'assistant_thinking' // Thinking/reasoning output
  | 'assistant_tool_use' // Tool use request (output)
  | 'tool_execution' // Cross-request tool execution
  | 'synthetic' // Synthetic grouping span for orphan parents
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
  cost: number | null;
  baggage: Record<string, string>;
}

function parseAttributes(attributesJson: string): Record<string, string> {
  try {
    return JSON.parse(attributesJson) as Record<string, string>;
  } catch {
    return {};
  }
}

function getSpanType(span: TraceSpan): SpanType {
  const attrs = parseAttributes(span.SpanAttributes);

  // Synthetic grouping spans
  if (attrs.synthetic === 'true') return 'synthetic';

  const name = span.SpanName.toLowerCase();

  // Infrastructure spans (muted)
  if (name === 'ai.request' || name.includes('chat/completions')) return 'llm';

  // Input message spans (warm tones) - ai.request.{role} pattern
  if (name === 'ai.request.system') return 'system';
  if (name === 'ai.request.user') return 'user';
  if (name === 'ai.request.assistant') return 'assistant_input';
  if (name === 'ai.request.tool_result') return 'tool_result';

  // Output spans (cool/vibrant tones) - ai.response.{type} pattern
  if (name.startsWith('ai.response.text')) return 'assistant_text';
  if (name.startsWith('ai.response.thinking')) return 'assistant_thinking';
  if (name.startsWith('ai.response.tool_use')) return 'assistant_tool_use';

  // Tool execution
  if (name === 'ai.tool.execution') return 'tool_execution';

  // Fallback for other response outputs (numbered variants like ai.response.text.2)
  if (name.startsWith('ai.response.')) return 'assistant_text';

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

  // Use pre-calculated TPS if available
  if (attrs['ai.tokens_per_second']) {
    return parseFloat(attrs['ai.tokens_per_second']);
  }

  // Fallback for older spans without pre-calculated TPS
  const completion =
    parseInt(attrs['ai.tokens.completion'] ?? '0', 10) ||
    parseInt(attrs['ai.tokens.output'] ?? '0', 10) ||
    parseInt(attrs['gen_ai.usage.output_tokens'] ?? '0', 10);

  const durationSeconds = span.Duration / 1_000_000_000;
  return durationSeconds > 0 && completion > 0 ? completion / durationSeconds : null;
}

function getSpanCost(span: TraceSpan): number | null {
  const attrs = parseAttributes(span.SpanAttributes);
  const cost = attrs['ai.cost.total'];
  return cost ? parseFloat(cost) : null;
}

function getBaggageAttributes(span: TraceSpan): Record<string, string> {
  const attrs = parseAttributes(span.SpanAttributes);
  const baggage: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('baggage.')) {
      baggage[key.replace('baggage.', '')] = value;
    }
  }
  return baggage;
}

function getMessageIndex(span: TraceSpan): number | null {
  const attrs = parseAttributes(span.SpanAttributes);
  const index = attrs['ai.message.index'];
  return index !== undefined ? parseInt(index, 10) : null;
}

function isHollowType(type: SpanType): boolean {
  return type === 'llm' || type === 'synthetic';
}

// Color palette for synthetic spans based on operation name
const syntheticColorPalette = [
  { border: 'border-teal-400', bg: 'bg-teal-500/15', text: 'text-teal-400' },
  { border: 'border-rose-400', bg: 'bg-rose-500/15', text: 'text-rose-400' },
  { border: 'border-amber-400', bg: 'bg-amber-500/15', text: 'text-amber-400' },
  { border: 'border-sky-400', bg: 'bg-sky-500/15', text: 'text-sky-400' },
  { border: 'border-purple-400', bg: 'bg-purple-500/15', text: 'text-purple-400' },
  { border: 'border-lime-400', bg: 'bg-lime-500/15', text: 'text-lime-400' },
  { border: 'border-pink-400', bg: 'bg-pink-500/15', text: 'text-pink-400' },
  { border: 'border-cyan-400', bg: 'bg-cyan-500/15', text: 'text-cyan-400' },
];

function getSyntheticColorIndex(spanName: string): number {
  let hash = 0;
  for (let i = 0; i < spanName.length; i++) {
    hash = (hash << 5) - hash + spanName.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash) % syntheticColorPalette.length;
}

function getSyntheticColor(span: TraceSpan): { border: string; bg: string; text: string } {
  const index = getSyntheticColorIndex(span.SpanName);
  return syntheticColorPalette[index];
}

function getTypeColor(type: SpanType, status: string, span?: TraceSpan): string {
  if (status === 'ERROR') return 'bg-red-500';

  switch (type) {
    // Infrastructure - hollow style (handled separately in JSX)
    case 'llm':
      return 'border-violet-400 bg-violet-500/10';

    // Synthetic grouping spans - hollow style with dynamic colors
    case 'synthetic': {
      if (span) {
        const colors = getSyntheticColor(span);
        return `${colors.border} ${colors.bg}`;
      }
      return 'border-zinc-500/70 bg-zinc-500/5';
    }

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

    // Synthetic grouping spans
    case 'synthetic':
      return <Layers className="h-3.5 w-3.5" />;

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

function getTypeIconColor(type: SpanType, span?: TraceSpan): string {
  switch (type) {
    // Infrastructure - colored to match hollow bars
    case 'llm':
      return 'text-violet-400';

    // Synthetic grouping spans - dynamic colors
    case 'synthetic':
      if (span) {
        return getSyntheticColor(span).text;
      }
      return 'text-zinc-400';

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
  spanAlertSummary,
}: AgentGanttChartProps) {
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [hoveredSpanId, setHoveredSpanId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { spanRows, totalDuration, childrenMap, syntheticSpanIds } = useMemo(() => {
    if (spans.length === 0)
      return {
        spanRows: [],
        totalDuration: 0,
        childrenMap: new Map(),
        syntheticSpanIds: new Set<string>(),
      };

    const spanIds = new Set(spans.map((s) => s.SpanId));

    // Find orphan parent IDs (ParentSpanIds that don't exist in our span set)
    const orphanParentIds = new Map<string, TraceSpan[]>();
    for (const span of spans) {
      if (span.ParentSpanId && !spanIds.has(span.ParentSpanId)) {
        const group = orphanParentIds.get(span.ParentSpanId) ?? [];
        group.push(span);
        orphanParentIds.set(span.ParentSpanId, group);
      }
    }

    // Create synthetic parent spans for orphan groups
    const syntheticSpans: TraceSpan[] = [];
    for (const [parentId, childSpans] of orphanParentIds) {
      if (childSpans.length > 0) {
        const earliestStart = Math.min(...childSpans.map((s) => s.Timestamp));
        const latestEnd = Math.max(...childSpans.map((s) => s.Timestamp + s.Duration));

        // Get operation from first child's baggage for labeling
        const firstChildAttrs = parseAttributes(childSpans[0].SpanAttributes);
        const operation = firstChildAttrs['baggage.operation'] ?? 'group';

        syntheticSpans.push({
          Timestamp: earliestStart,
          TraceId: childSpans[0].TraceId,
          SpanId: parentId,
          ParentSpanId: '',
          SpanName: operation,
          ServiceName: childSpans[0].ServiceName,
          Duration: latestEnd - earliestStart,
          StatusCode: 'OK',
          SpanAttributes: JSON.stringify({ synthetic: 'true', 'baggage.operation': operation }),
        });
      }
    }

    // Establish hierarchy among synthetic spans:
    // The earliest one becomes the root, others become its children
    if (syntheticSpans.length > 1) {
      syntheticSpans.sort((a, b) => a.Timestamp - b.Timestamp);
      const rootSynthetic = syntheticSpans[0];

      // Make other synthetic spans children of the root
      for (let i = 1; i < syntheticSpans.length; i++) {
        syntheticSpans[i].ParentSpanId = rootSynthetic.SpanId;
      }

      // Extend root's duration to cover all synthetic spans
      const latestEnd = Math.max(...syntheticSpans.map((s) => s.Timestamp + s.Duration));
      rootSynthetic.Duration = latestEnd - rootSynthetic.Timestamp;
    }

    // Combine synthetic and real spans
    const allSpans = [...syntheticSpans, ...spans];
    const allSpanIds = new Set(allSpans.map((s) => s.SpanId));

    // Build a map of spans that have children (using combined spans)
    const childrenMap = new Map<string, boolean>();
    for (const span of allSpans) {
      if (span.ParentSpanId) {
        childrenMap.set(span.ParentSpanId, true);
      }
    }

    // Find ALL root spans (spans whose parent is not in the span set or is empty)
    const rootSpans = allSpans
      .filter((s) => s.ParentSpanId === '' || !allSpanIds.has(s.ParentSpanId))
      .sort((a, b) => a.Timestamp - b.Timestamp);

    // Fallback to earliest span if no roots found
    const effectiveRoots =
      rootSpans.length > 0
        ? rootSpans
        : [allSpans.reduce((a, b) => (a.Timestamp < b.Timestamp ? a : b))];

    const traceStart = Math.min(...effectiveRoots.map((s) => s.Timestamp));
    const traceEndTime = Math.max(...allSpans.map((s) => s.Timestamp + s.Duration));
    const total = traceEndTime - traceStart;

    const buildSpanTree = (parentId: string, depth = 0): SpanRow[] => {
      const children = allSpans
        .filter((s) => s.ParentSpanId === parentId)
        .sort((a, b) => {
          const timeDiff = a.Timestamp - b.Timestamp;
          if (timeDiff !== 0) return timeDiff;
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
        rows.push({
          span,
          depth,
          startOffset,
          width: Math.max(width, 0.5),
          type: getSpanType(span),
          tokens: getSpanTokens(span),
          tokensPerSecond: getSpanTokensPerSecond(span),
          messageIndex: getMessageIndex(span),
          cost: getSpanCost(span),
          baggage: getBaggageAttributes(span),
        });
        rows.push(...buildSpanTree(span.SpanId, depth + 1));
      }
      return rows;
    };

    const allRows: SpanRow[] = [];
    for (const rootSpan of effectiveRoots) {
      const startOffset = ((rootSpan.Timestamp - traceStart) / total) * 100;
      allRows.push({
        span: rootSpan,
        depth: 0,
        startOffset,
        width: Math.max((rootSpan.Duration / total) * 100, 0.5),
        type: getSpanType(rootSpan),
        tokens: getSpanTokens(rootSpan),
        tokensPerSecond: getSpanTokensPerSecond(rootSpan),
        messageIndex: getMessageIndex(rootSpan),
        cost: getSpanCost(rootSpan),
        baggage: getBaggageAttributes(rootSpan),
      });
      allRows.push(...buildSpanTree(rootSpan.SpanId, 1));
    }

    // Collect synthetic span IDs for auto-expansion
    const syntheticSpanIds = new Set(syntheticSpans.map((s) => s.SpanId));

    return { spanRows: allRows, totalDuration: total, childrenMap, syntheticSpanIds };
  }, [spans]);

  // Auto-expand synthetic spans by default
  useEffect(() => {
    if (syntheticSpanIds.size > 0) {
      setExpandedSpans((prev) => {
        const next = new Set(prev);
        for (const id of syntheticSpanIds) {
          next.add(id);
        }
        return next;
      });
    }
  }, [syntheticSpanIds]);

  // Filter to visible rows based on expansion state
  const visibleRows = useMemo(() => {
    return spanRows.filter((row) => {
      if (row.depth === 0) return true; // Always show root spans
      // For non-root spans, check if immediate parent is expanded
      return expandedSpans.has(row.span.ParentSpanId);
    });
  }, [spanRows, expandedSpans]);

  const toggleExpand = (spanId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedSpans((prev) => {
      const next = new Set(prev);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  };

  const expandAll = () => {
    const allSpansWithChildren = new Set<string>();
    for (const [spanId] of childrenMap) {
      allSpansWithChildren.add(spanId);
    }
    setExpandedSpans(allSpansWithChildren);
  };

  const collapseAll = () => {
    setExpandedSpans(new Set());
  };

  if (spanRows.length === 0) {
    return null;
  }

  const timeMarkers = [0, 0.25, 0.5, 0.75, 1].map((pct) => ({
    position: pct * 100,
    label: formatDuration(totalDuration * pct),
  }));

  const handleMouseMove = (e: React.MouseEvent, spanId: string) => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      setHoveredSpanId(spanId);
    }
  };

  const handleMouseLeave = () => {
    setMousePos(null);
    setHoveredSpanId(null);
  };

  const hoveredRow = hoveredSpanId
    ? visibleRows.find((r) => r.span.SpanId === hoveredSpanId)
    : null;
  const hoveredAlertSummary = hoveredSpanId ? spanAlertSummary?.get(hoveredSpanId) : null;
  const hoveredTriggeredAlerts = hoveredAlertSummary?.triggeredAlerts ?? [];

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden rounded-xl border border-border/50 bg-card"
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex border-b border-border/30 bg-muted/20">
        <div className="flex w-56 shrink-0 items-center justify-between border-r border-border/30 px-4 py-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Span
          </span>
          {childrenMap.size > 0 && (
            <button
              onClick={expandedSpans.size > 0 ? collapseAll : expandAll}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={expandedSpans.size > 0 ? 'Collapse all' : 'Expand all'}
            >
              <ChevronsUpDown className="h-3 w-3" />
            </button>
          )}
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

      <div className="relative">
        {visibleRows.map((row) => {
          const hasChildren = childrenMap.has(row.span.SpanId);
          const isExpanded = expandedSpans.has(row.span.SpanId);
          const alertSummary = spanAlertSummary?.get(row.span.SpanId);
          const alertStyles = alertSummary?.highestSeverity
            ? alertSeverityStyles[alertSummary.highestSeverity]
            : null;

          return (
            <div
              key={row.span.SpanId}
              className={`group flex border-b border-border/20 transition-colors hover:bg-muted/30 ${
                selectedSpanId === row.span.SpanId ? 'bg-primary/5' : ''
              } ${onSpanSelect ? 'cursor-pointer' : ''}`}
              onClick={() => onSpanSelect?.(row.span.SpanId)}
              onMouseMove={(e) => handleMouseMove(e, row.span.SpanId)}
            >
              <div
                className="flex w-56 shrink-0 items-center gap-1 border-r border-border/30 py-2 pr-2"
                style={{ paddingLeft: `${8 + row.depth * 16}px` }}
              >
                {hasChildren ? (
                  <button
                    onClick={(e) => toggleExpand(row.span.SpanId, e)}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </button>
                ) : (
                  <div className="h-4 w-4 shrink-0" />
                )}
                <span className={`shrink-0 ${getTypeIconColor(row.type, row.span)}`}>
                  {getTypeIcon(row.type)}
                </span>
                <span className="truncate text-xs text-foreground" title={row.span.SpanName}>
                  {row.span.SpanName}
                </span>
              </div>

              <div className="relative flex-1 px-4 py-2">
                <div className="relative h-5">
                  <div
                    className={`absolute h-full rounded transition-opacity group-hover:opacity-90 ${isHollowType(row.type) ? 'border' : ''} ${getTypeColor(row.type, row.span.StatusCode, row.span)} ${alertStyles?.glow ?? ''}`}
                    style={{
                      left: `${row.startOffset}%`,
                      width: `${row.width}%`,
                      minWidth: '4px',
                    }}
                  >
                    {alertStyles && (
                      <div
                        className={`absolute left-0 top-0 h-full w-[3px] rounded-l ${alertStyles.edge}`}
                      />
                    )}
                    {row.tokens !== null && row.width > 8 && (
                      <span className="absolute inset-0 flex items-center justify-center text-[9px] font-medium text-white/90">
                        {formatNumber(row.tokens)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
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

      {mousePos && hoveredRow && (
        <div
          className="pointer-events-none absolute z-50 rounded-md bg-popover px-2.5 py-1.5 text-xs shadow-lg ring-1 ring-border/50"
          style={{
            left: mousePos.x + 12,
            top: mousePos.y + 12,
          }}
        >
          <div className="flex items-center gap-2 whitespace-nowrap">
            <span className="font-medium text-foreground">{hoveredRow.span.SpanName}</span>
            <span className="text-muted-foreground">·</span>
            <span className="tabular-nums text-muted-foreground">
              {formatDuration(hoveredRow.span.Duration)}
            </span>
            {hoveredRow.tokens !== null && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatNumber(hoveredRow.tokens)} tokens
                </span>
              </>
            )}
            {hoveredRow.tokensPerSecond !== null && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="tabular-nums text-muted-foreground">
                  {hoveredRow.tokensPerSecond.toFixed(1)} tok/s
                </span>
              </>
            )}
            {hoveredRow.type === 'llm' && hoveredRow.cost !== null && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="tabular-nums text-emerald-400">${hoveredRow.cost.toFixed(6)}</span>
              </>
            )}
            {hoveredRow.type === 'llm' && hoveredRow.baggage.operation && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="rounded bg-teal-500/15 px-1.5 py-0.5 text-[10px] font-medium text-teal-400">
                  {hoveredRow.baggage.operation}
                </span>
              </>
            )}
          </div>
          {hoveredRow.type === 'llm' &&
            Object.keys(hoveredRow.baggage).filter((k) => k !== 'operation').length > 0 && (
              <div className="mt-1.5 border-t border-border/30 pt-1.5">
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {Object.entries(hoveredRow.baggage)
                    .filter(([k]) => k !== 'operation')
                    .map(([key, value]) => (
                      <span key={key} className="whitespace-nowrap text-[10px]">
                        <span className="text-muted-foreground/70">{key}:</span>{' '}
                        <span className="text-foreground/80">{value}</span>
                      </span>
                    ))}
                </div>
              </div>
            )}
          {hoveredRow.type === 'llm' && hoveredTriggeredAlerts.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5 border-t border-border/30 pt-1.5">
              {hoveredTriggeredAlerts.map((ta, idx) => {
                const severity = ta.alert.severity as AlertSeverity;
                const style = alertSeverityStyles[severity];
                const Icon = style.icon;
                return (
                  <span
                    key={idx}
                    className={`inline-flex items-center gap-1 whitespace-nowrap ${style.text}`}
                  >
                    <Icon className="h-3 w-3" />
                    <span>{ta.alert.name}</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
