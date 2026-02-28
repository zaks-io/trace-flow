import { useMemo, useState, useRef } from 'react';
import { parseSpanAttributes } from '@trace-flow/utils';
import { formatDuration as formatDurationMs, formatNumber, formatCurrency } from '@/lib/format';
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

type TimelineMode = 'duration' | 'tokens' | 'cost';

interface SpanRow {
  span: TraceSpan;
  depth: number;
  isLastPath: boolean[];
  startOffset: number;
  width: number;
  type: SpanType;
  tokens: number | null;
  tokensPerSecond: number | null;
  messageIndex: number | null;
  cost: number | null;
  model: string | null;
  operationName: string | null;
  baggage: Record<string, string>;
  isCacheHit: boolean;
  subtreeTokens: number;
  subtreeCost: number;
  subtreeModels: Set<string>;
  subtreeOperations: Set<string>;
  subtreeTps: number | null;
  hasErrorDescendant: boolean;
}

function getSpanModel(attrs: Record<string, string>): string | null {
  const raw =
    attrs['gen_ai.request.model'] || attrs['llm.request.model'] || attrs['gen_ai.system'] || null;
  if (!raw) return null;
  const provider = attrs['gen_ai.system'];
  if (!provider) return raw;
  const name = raw.includes('/') ? raw.split('/').slice(1).join('/') : raw;
  return `${provider}/${name}`;
}

function shortenModelName(model: string): string {
  const bare = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  const withoutDate = bare.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const shorts: Record<string, string> = {
    'claude-sonnet-4': 'sonnet-4',
    'claude-opus-4': 'opus-4',
    'claude-3-5-sonnet': 'sonnet-3.5',
    'claude-3-5-haiku': 'haiku-3.5',
    'claude-3-opus': 'opus-3',
    'claude-3-haiku': 'haiku-3',
    'gpt-4o-mini': '4o-mini',
    'gpt-4o': '4o',
    'gpt-4-turbo': '4-turbo',
    'gpt-4.1': '4.1',
    'gpt-4.1-mini': '4.1-mini',
    'gpt-4.1-nano': '4.1-nano',
    'o3-mini': 'o3-mini',
  };
  return shorts[withoutDate] ?? withoutDate;
}

function getPrimaryLabel(row: SpanRow): {
  text: string;
  isOperation: boolean;
  originalName: string;
} {
  // LLM spans: always show the model name
  if (row.type === 'llm' && row.model) {
    return {
      text: shortenModelName(row.model),
      isOperation: false,
      originalName: row.span.SpanName,
    };
  }

  // User-provided operation label
  if (row.baggage.operation) {
    return { text: row.baggage.operation, isOperation: true, originalName: row.span.SpanName };
  }

  // Parent/root rows: show subtree operations or operation name
  if (row.subtreeOperations.size > 0) {
    const ops = [...row.subtreeOperations];
    const text = ops.length === 1 ? ops[0] : `${ops[0]} +${ops.length - 1}`;
    return { text, isOperation: true, originalName: row.span.SpanName };
  }
  if (row.depth === 0 && row.operationName) {
    return { text: row.operationName, isOperation: false, originalName: row.span.SpanName };
  }

  return { text: row.span.SpanName, isOperation: false, originalName: row.span.SpanName };
}

function getSpanType(span: TraceSpan, attrs: Record<string, string>): SpanType {
  // Synthetic grouping spans
  if (attrs.synthetic === 'true') return 'synthetic';

  const name = span.SpanName.toLowerCase();

  // OTel GenAI semantic conventions: span names like "chat gpt-4", "embeddings text-embedding-3-small"
  // Also check gen_ai.operation.name attribute for new-style spans
  const operationName = attrs['gen_ai.operation.name']?.toLowerCase();
  if (
    operationName === 'chat' ||
    operationName === 'text_completion' ||
    operationName === 'generate_content' ||
    operationName === 'embeddings' ||
    operationName === 'invoke_agent'
  ) {
    return 'llm';
  }

  // Legacy infrastructure spans (muted)
  if (name === 'gen_ai.request' || name.includes('chat/completions')) return 'llm';

  // Output spans (cool/vibrant tones) - gen_ai.response.{type} pattern
  if (name.startsWith('gen_ai.response.text')) return 'assistant_text';
  if (name.startsWith('gen_ai.response.thinking')) return 'assistant_thinking';
  if (name.startsWith('gen_ai.response.tool_use')) return 'assistant_tool_use';

  // Tool execution
  if (name === 'gen_ai.tool.execution') return 'tool_execution';

  // Fallback for other response outputs (numbered variants like gen_ai.response.text.2)
  if (name.startsWith('gen_ai.response.')) return 'assistant_text';

  return 'internal';
}

function getSpanTokens(attrs: Record<string, string>): number | null {
  const input = parseInt(attrs['gen_ai.usage.input_tokens'] ?? '0', 10);
  const output = parseInt(attrs['gen_ai.usage.output_tokens'] ?? '0', 10);
  const total = input + output;

  return total > 0 ? total : null;
}

function getSpanTokensPerSecond(_span: TraceSpan, attrs: Record<string, string>): number | null {
  const tps = attrs['gen_ai.tokens_per_second'];
  return tps ? parseFloat(tps) : null;
}

function getSpanCost(attrs: Record<string, string>): number | null {
  const cost = attrs['gen_ai.cost.total'];
  return cost ? parseFloat(cost) : null;
}

function getBaggageAttributes(attrs: Record<string, string>): Record<string, string> {
  const baggage: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('baggage.')) {
      baggage[key.replace('baggage.', '')] = value;
    }
  }
  return baggage;
}

function getMessageIndex(attrs: Record<string, string>): number | null {
  const index = attrs['gen_ai.message.index'];
  return index !== undefined ? parseInt(index, 10) : null;
}

function isHollowType(type: SpanType): boolean {
  return type === 'llm' || type === 'synthetic' || type === 'internal';
}

// Color palette for synthetic spans based on operation name
const syntheticColorPalette = [
  {
    border: 'border-teal-400',
    bg: 'bg-teal-500/15',
    bgStrong: 'bg-teal-500/40',
    text: 'text-teal-400',
  },
  {
    border: 'border-rose-400',
    bg: 'bg-rose-500/15',
    bgStrong: 'bg-rose-500/40',
    text: 'text-rose-400',
  },
  {
    border: 'border-amber-400',
    bg: 'bg-amber-500/15',
    bgStrong: 'bg-amber-500/40',
    text: 'text-amber-400',
  },
  {
    border: 'border-sky-400',
    bg: 'bg-sky-500/15',
    bgStrong: 'bg-sky-500/40',
    text: 'text-sky-400',
  },
  {
    border: 'border-purple-400',
    bg: 'bg-purple-500/15',
    bgStrong: 'bg-purple-500/40',
    text: 'text-purple-400',
  },
  {
    border: 'border-lime-400',
    bg: 'bg-lime-500/15',
    bgStrong: 'bg-lime-500/40',
    text: 'text-lime-400',
  },
  {
    border: 'border-pink-400',
    bg: 'bg-pink-500/15',
    bgStrong: 'bg-pink-500/40',
    text: 'text-pink-400',
  },
  {
    border: 'border-cyan-400',
    bg: 'bg-cyan-500/15',
    bgStrong: 'bg-cyan-500/40',
    text: 'text-cyan-400',
  },
];

function getSyntheticColorIndex(spanName: string): number {
  let hash = 0;
  for (let i = 0; i < spanName.length; i++) {
    hash = (hash << 5) - hash + spanName.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash) % syntheticColorPalette.length;
}

function getSyntheticColor(span: TraceSpan): {
  border: string;
  bg: string;
  bgStrong: string;
  text: string;
} {
  const index = getSyntheticColorIndex(span.SpanName);
  return syntheticColorPalette[index];
}

function getInternalColor(span: TraceSpan, depth?: number): string {
  const index = getSyntheticColorIndex(span.SpanName);
  const colors = syntheticColorPalette[index];
  return `${colors.border} ${depth === 0 ? colors.bgStrong : colors.bg}`;
}

function getTypeColor(type: SpanType, status: string, span?: TraceSpan, depth?: number): string {
  if (status === 'ERROR') return 'bg-red-500';

  const isRoot = depth === 0;

  switch (type) {
    case 'llm':
      return isRoot ? 'border-violet-400 bg-violet-500/40' : 'border-violet-400 bg-violet-500/10';

    case 'synthetic': {
      if (span) {
        const colors = getSyntheticColor(span);
        return `${colors.border} ${isRoot ? colors.bgStrong : colors.bg}`;
      }
      return isRoot ? 'border-zinc-500/70 bg-zinc-500/20' : 'border-zinc-500/70 bg-zinc-500/5';
    }

    case 'system':
      return 'bg-slate-500';
    case 'user':
      return 'bg-emerald-500';
    case 'assistant_input':
      return 'bg-sky-400';
    case 'tool_result':
      return 'bg-amber-500';

    case 'assistant_text':
      return 'bg-indigo-500';
    case 'assistant_thinking':
      return 'bg-violet-500';
    case 'assistant_tool_use':
      return 'bg-cyan-500';

    case 'tool_execution':
      return 'bg-orange-500';

    case 'internal':
      if (span) {
        return getInternalColor(span, depth);
      }
      return isRoot ? 'border-zinc-500/70 bg-zinc-500/20' : 'border-zinc-500/70 bg-zinc-500/5';

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

    // Internal/custom spans - dynamic colors
    case 'internal':
      if (span) {
        return getSyntheticColor(span).text;
      }
      return 'text-zinc-400';

    default:
      return 'text-zinc-400';
  }
}

function formatDuration(nanoseconds: number): string {
  return formatDurationMs(nanoseconds / 1_000_000);
}

function getAdaptiveInterval(totalDurationNs: number): number {
  const totalMs = totalDurationNs / 1_000_000;
  const intervals = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];
  const targetTicks = 10;
  const idealIntervalMs = totalMs / targetTicks;

  let selected = intervals[0];
  for (const interval of intervals) {
    if (interval <= idealIntervalMs) selected = interval;
    else break;
  }
  return selected * 1_000_000;
}

function getMetricInterval(maxValue: number): number {
  const intervals = [
    1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000,
    500000, 1000000,
  ];
  const targetTicks = 8;
  const idealInterval = maxValue / targetTicks;
  let selected = intervals[0];
  for (const interval of intervals) {
    if (interval <= idealInterval) selected = interval;
    else break;
  }
  return selected;
}

export function AgentGanttChart({
  spans,
  selectedSpanId,
  onSpanSelect,
  parentSpanId,
  spanAlertSummary,
}: AgentGanttChartProps) {
  const [timelineMode, setTimelineMode] = useState<TimelineMode>('duration');
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());
  const [mousePos, setMousePos] = useState<{
    x: number;
    y: number;
    containerWidth: number;
    containerHeight: number;
  } | null>(null);
  const [hoveredSpanId, setHoveredSpanId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { spanRows, totalDuration, childrenMap } = useMemo(() => {
    if (spans.length === 0)
      return {
        spanRows: [],
        totalDuration: 0,
        childrenMap: new Map(),
        syntheticChildrenMap: new Map<string, TraceSpan[]>(),
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

        // Get operation from first child's gen_ai.operation.name or baggage for labeling
        const firstChildAttrs = parseSpanAttributes(childSpans[0].SpanAttributes);
        const operation =
          firstChildAttrs['gen_ai.operation.name'] ??
          firstChildAttrs['baggage.operation'] ??
          'group';

        syntheticSpans.push({
          Timestamp: earliestStart,
          TraceId: childSpans[0].TraceId,
          SpanId: parentId,
          ParentSpanId: '',
          SpanName: operation,
          ServiceName: childSpans[0].ServiceName,
          Duration: latestEnd - earliestStart,
          StatusCode: 'OK',
          SpanAttributes: JSON.stringify({
            synthetic: 'true',
            'gen_ai.operation.name': operation,
          }),
        });
      }
    }

    // Combine synthetic and real spans
    const allSpans = [...syntheticSpans, ...spans];
    const allSpanIds = new Set(allSpans.map((s) => s.SpanId));

    // Build a map of spans that have children (using combined spans)
    const childrenMap = new Map<string, number>();
    for (const span of allSpans) {
      if (span.ParentSpanId) {
        childrenMap.set(span.ParentSpanId, (childrenMap.get(span.ParentSpanId) ?? 0) + 1);
      }
    }

    // Find ALL root spans (spans whose parent is not in the span set or is empty)
    const rootSpans = allSpans
      .filter((s) => s.ParentSpanId === '' || !allSpanIds.has(s.ParentSpanId))
      .sort((a, b) => a.Timestamp - b.Timestamp || a.SpanId.localeCompare(b.SpanId));

    // Fallback to earliest span if no roots found
    const effectiveRoots =
      rootSpans.length > 0
        ? rootSpans
        : [allSpans.reduce((a, b) => (a.Timestamp < b.Timestamp ? a : b))];

    const traceStart = Math.min(...effectiveRoots.map((s) => s.Timestamp));
    const traceEndTime = Math.max(...allSpans.map((s) => s.Timestamp + s.Duration));
    const total = traceEndTime - traceStart;

    // Pre-compute lookup maps: O(n) instead of O(n²) find/filter in recursive traversals
    const spanById = new Map<string, TraceSpan>();
    const childrenByParent = new Map<string, TraceSpan[]>();
    const parsedAttrs = new Map<string, Record<string, string>>();
    for (const span of allSpans) {
      spanById.set(span.SpanId, span);
      parsedAttrs.set(span.SpanId, parseSpanAttributes(span.SpanAttributes));
      const siblings = childrenByParent.get(span.ParentSpanId);
      if (siblings) {
        siblings.push(span);
      } else {
        childrenByParent.set(span.ParentSpanId, [span]);
      }
    }

    // --- Pre-compute subtree metrics ---
    const subtreeMetrics = new Map<
      string,
      {
        tokens: number;
        cost: number;
        models: Set<string>;
        operations: Set<string>;
        hasError: boolean;
        tpsSpans: { tps: number; outputTokens: number }[];
      }
    >();

    const computeMetrics = (spanId: string) => {
      if (subtreeMetrics.has(spanId)) return subtreeMetrics.get(spanId)!;

      const span = spanById.get(spanId);
      const children = childrenByParent.get(spanId) ?? [];
      const attrs = span ? parsedAttrs.get(spanId)! : {};

      let tokens = span ? (getSpanTokens(attrs) ?? 0) : 0;
      let cost = span ? (getSpanCost(attrs) ?? 0) : 0;
      const models = new Set<string>();
      const operations = new Set<string>();
      let hasError = span?.StatusCode === 'ERROR';
      const tpsSpans: { tps: number; outputTokens: number }[] = [];

      if (span) {
        const model = getSpanModel(attrs);
        if (model) models.add(model);

        const op = attrs['baggage.operation'];
        if (op) operations.add(op);

        const tps = getSpanTokensPerSecond(span, attrs);
        const outputTokens = parseInt(attrs['gen_ai.usage.output_tokens'] ?? '0', 10);
        if (tps !== null && outputTokens > 0) {
          tpsSpans.push({ tps, outputTokens });
        }
      }

      for (const child of children) {
        const childMetrics = computeMetrics(child.SpanId);
        tokens += childMetrics.tokens;
        cost += childMetrics.cost;
        for (const m of childMetrics.models) models.add(m);
        for (const o of childMetrics.operations) operations.add(o);
        hasError = hasError || childMetrics.hasError;
        tpsSpans.push(...childMetrics.tpsSpans);
      }

      const result = { tokens, cost, models, operations, hasError, tpsSpans };
      subtreeMetrics.set(spanId, result);
      return result;
    };

    for (const span of allSpans) {
      computeMetrics(span.SpanId);
    }

    // -----------------------------------

    const buildSpanRow = (span: TraceSpan, depth: number, isLastPath: boolean[]): SpanRow => {
      const attrs = parsedAttrs.get(span.SpanId)!;
      const cacheRead = parseInt(attrs['gen_ai.usage.cache_read_input_tokens'] ?? '0', 10);
      const metrics = subtreeMetrics.get(span.SpanId)!;
      const startOffset = ((span.Timestamp - traceStart) / total) * 100;
      const width = (span.Duration / total) * 100;

      return {
        span,
        depth,
        isLastPath,
        startOffset,
        width: Math.max(width, 0.5),
        type: getSpanType(span, attrs),
        model: getSpanModel(attrs),
        operationName: attrs['gen_ai.operation.name'] || null,
        tokens: getSpanTokens(attrs),
        tokensPerSecond: getSpanTokensPerSecond(span, attrs),
        messageIndex: getMessageIndex(attrs),
        cost: getSpanCost(attrs),
        baggage: getBaggageAttributes(attrs),
        isCacheHit: cacheRead > 0,
        subtreeTokens: metrics.tokens,
        subtreeCost: metrics.cost,
        subtreeModels: metrics.models,
        subtreeOperations: metrics.operations,
        subtreeTps:
          metrics.tpsSpans.length > 0
            ? metrics.tpsSpans.reduce((sum, s) => sum + s.outputTokens, 0) /
              metrics.tpsSpans.reduce((sum, s) => sum + s.outputTokens / s.tps, 0)
            : null,
        hasErrorDescendant: metrics.hasError,
      };
    };

    const buildSpanTree = (parentId: string, depth = 0, isLastPath: boolean[] = []): SpanRow[] => {
      const children = childrenByParent.get(parentId) ?? [];

      // Group children by type:
      // - ai.* spans group by their exact name (e.g., all ai.request together)
      // - Other spans (named agents) are their own group
      const groups = new Map<string, TraceSpan[]>();
      for (const child of children) {
        const name = child.SpanName.toLowerCase();
        const groupKey = name.startsWith('gen_ai.') ? child.SpanName : child.SpanId;
        if (!groups.has(groupKey)) {
          groups.set(groupKey, []);
        }
        groups.get(groupKey)!.push(child);
      }

      // Sort spans within each group by timestamp, then message index
      for (const groupSpans of groups.values()) {
        groupSpans.sort((a, b) => {
          const timeDiff = a.Timestamp - b.Timestamp;
          if (timeDiff !== 0) return timeDiff;
          const aAttrs = parsedAttrs.get(a.SpanId)!;
          const bAttrs = parsedAttrs.get(b.SpanId)!;
          const aIndex = getMessageIndex(aAttrs);
          const bIndex = getMessageIndex(bAttrs);
          if (aIndex !== null && bIndex !== null) return aIndex - bIndex;
          if (aIndex !== null) return -1;
          if (bIndex !== null) return 1;
          return a.SpanId.localeCompare(b.SpanId);
        });
      }

      // Order groups by when their first span occurred
      const sortedGroups = [...groups.entries()].sort(([, spansA], [, spansB]) => {
        return (
          spansA[0].Timestamp - spansB[0].Timestamp ||
          spansA[0].SpanId.localeCompare(spansB[0].SpanId)
        );
      });

      // Flatten groups into rows
      const rows: SpanRow[] = [];
      for (let g = 0; g < sortedGroups.length; g++) {
        const groupSpans = sortedGroups[g][1];
        for (let s = 0; s < groupSpans.length; s++) {
          const span = groupSpans[s];
          const isLastInGroup = s === groupSpans.length - 1;
          const isLastGroup = g === sortedGroups.length - 1;
          const isLastChild = isLastInGroup && isLastGroup;
          const childPath = [...isLastPath, isLastChild];

          rows.push(buildSpanRow(span, depth, childPath));
          rows.push(...buildSpanTree(span.SpanId, depth + 1, childPath));
        }
      }
      return rows;
    };

    const allRows: SpanRow[] = [];
    for (let r = 0; r < effectiveRoots.length; r++) {
      const rootSpan = effectiveRoots[r];
      const isLastRoot = r === effectiveRoots.length - 1;

      allRows.push(buildSpanRow(rootSpan, 0, [isLastRoot]));
      allRows.push(...buildSpanTree(rootSpan.SpanId, 1, [isLastRoot]));
    }

    return {
      spanRows: allRows,
      totalDuration: total,
      childrenMap,
    };
  }, [spans]);

  // Filter to visible rows based on expansion state
  const visibleRows = useMemo(() => {
    const visibleIds = new Set<string>();
    return spanRows.filter((row) => {
      if (row.depth === 0) {
        visibleIds.add(row.span.SpanId);
        return true;
      }
      // Parent must be both visible and expanded for children to show
      if (visibleIds.has(row.span.ParentSpanId) && expandedSpans.has(row.span.ParentSpanId)) {
        visibleIds.add(row.span.SpanId);
        return true;
      }
      return false;
    });
  }, [spanRows, expandedSpans]);

  // Compute bar layout for tokens/cost modes
  const barLayout = useMemo(() => {
    if (timelineMode === 'duration') return null;

    const getValue = (row: SpanRow): number => {
      const hasChildren = childrenMap.has(row.span.SpanId);
      const isExpanded = expandedSpans.has(row.span.SpanId);
      const own = timelineMode === 'tokens' ? row.tokens : row.cost;
      const subtree = timelineMode === 'tokens' ? row.subtreeTokens : row.subtreeCost;

      // When collapsed with children, show subtree total.
      // When expanded, show the larger of own value or subtree so
      // the parent bar is never smaller than any child bar.
      if (hasChildren) {
        if (!isExpanded) return subtree;
        return Math.max(own ?? 0, subtree);
      }
      return own ?? 0;
    };

    const maxValue = Math.max(...visibleRows.map(getValue), Number.EPSILON);
    const layout = new Map<string, { left: number; width: number }>();
    for (const row of visibleRows) {
      const value = getValue(row);
      const widthPct = value > 0 ? (value / maxValue) * 100 : 0;
      layout.set(row.span.SpanId, { left: 0, width: widthPct > 0 ? Math.max(widthPct, 0.5) : 0 });
    }

    return { layout, maxValue };
  }, [timelineMode, visibleRows, expandedSpans, childrenMap]);

  // Adaptive tick lines based on trace duration or metric mode
  const tickLines = useMemo(() => {
    if (timelineMode !== 'duration') {
      const maxValue = barLayout?.maxValue ?? 0;
      if (maxValue === 0) return [];
      const interval = getMetricInterval(maxValue);
      const lines: number[] = [];
      let position = interval;
      while (position < maxValue) {
        lines.push((position / maxValue) * 100);
        position += interval;
      }
      return lines;
    }

    if (totalDuration === 0) return [];
    const intervalNs = getAdaptiveInterval(totalDuration);
    const lines: number[] = [];
    let position = intervalNs;
    while (position < totalDuration) {
      lines.push((position / totalDuration) * 100);
      position += intervalNs;
    }
    return lines;
  }, [totalDuration, timelineMode, barLayout]);

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

  const hoveredRow = hoveredSpanId
    ? visibleRows.find((r) => r.span.SpanId === hoveredSpanId)
    : null;

  if (spanRows.length === 0) {
    return null;
  }

  // Markers aligned with tick lines (0%, tick positions, 100%)
  const timeMarkers = [0, ...tickLines, 100].map((pct) => {
    if (timelineMode === 'duration') {
      return { position: pct, label: formatDuration((pct / 100) * totalDuration) };
    }
    const maxValue = barLayout?.maxValue ?? 0;
    const value = (pct / 100) * maxValue;
    return {
      position: pct,
      label: timelineMode === 'tokens' ? formatNumber(Math.round(value)) : formatCurrency(value),
    };
  });

  const handleMouseMove = (e: React.MouseEvent, spanId: string) => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setMousePos({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        containerWidth: rect.width,
        containerHeight: rect.height,
      });
      setHoveredSpanId(spanId);
    }
  };

  const handleMouseLeave = () => {
    setMousePos(null);
    setHoveredSpanId(null);
  };

  const hoveredAlertSummary = hoveredSpanId ? spanAlertSummary?.get(hoveredSpanId) : null;
  const hoveredTriggeredAlerts = hoveredAlertSummary?.triggeredAlerts ?? [];

  return (
    <div
      ref={containerRef}
      className="relative h-full overflow-auto rounded-xl border border-border/50 bg-card"
      onMouseLeave={handleMouseLeave}
    >
      {/* Sticky header */}
      <div className="sticky top-0 z-20 flex border-b border-border/30 bg-muted/80 backdrop-blur-sm">
        <div className="flex w-[500px] shrink-0 items-center border-r border-border/30 px-4 py-2">
          <div className="flex flex-1 items-center justify-between pr-4">
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
          <div className="flex w-16 shrink-0 items-center justify-end">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Duration
            </span>
          </div>
          <div className="flex w-20 shrink-0 items-center justify-end">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Tokens
            </span>
          </div>
          <div className="flex w-20 shrink-0 items-center justify-end">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Cost
            </span>
          </div>
        </div>
        <div className="relative flex-1 px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground leading-none">
              Timeline
            </span>
            <div className="flex rounded-md bg-muted/60 p-0.5">
              {(['duration', 'tokens', 'cost'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={(e) => {
                    e.stopPropagation();
                    setTimelineMode(mode);
                  }}
                  className={`rounded px-2 py-0.5 text-[10px] font-medium capitalize transition-colors ${
                    timelineMode === mode
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
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
          <div className="flex w-[500px] shrink-0 items-center border-r border-border/30 px-4 py-2">
            <span className="text-xs text-muted-foreground">Parent Span</span>
          </div>
          <div className="relative flex-1 px-4 py-2">
            <div className="h-5 w-full rounded border border-dashed border-zinc-500/50 bg-zinc-600/50" />
          </div>
        </div>
      )}

      <div className="relative">
        {/* Background tick lines - full height solid lines */}
        <div
          className="pointer-events-none absolute inset-y-0 right-4"
          style={{ left: 'calc(500px + 16px)' }}
        >
          {tickLines.map((pct, i) => (
            <div
              key={i}
              className="absolute top-0 h-full w-px bg-border/40"
              style={{ left: `${pct}%` }}
            />
          ))}
        </div>

        {visibleRows.map((row) => {
          const hasChildren = childrenMap.has(row.span.SpanId);
          const isExpanded = expandedSpans.has(row.span.SpanId);
          const alertSummary = spanAlertSummary?.get(row.span.SpanId);
          const alertStyles = alertSummary?.highestSeverity
            ? alertSeverityStyles[alertSummary.highestSeverity]
            : null;
          const isError =
            row.span.StatusCode === 'ERROR' ||
            (hasChildren && !isExpanded && row.hasErrorDescendant);

          return (
            <div
              key={row.span.SpanId}
              className={`group flex border-b transition-colors ${
                isError
                  ? 'border-red-500/20 bg-red-500/5 hover:bg-red-500/10'
                  : 'border-border/20 hover:bg-muted/30'
              } ${selectedSpanId === row.span.SpanId ? 'bg-primary/5' : ''} ${
                hasChildren || onSpanSelect ? 'cursor-pointer' : ''
              }`}
              onClick={() => {
                if (hasChildren) {
                  if (isExpanded) {
                    // Already expanded — select it to open the detail panel
                    onSpanSelect?.(row.span.SpanId);
                  } else {
                    setExpandedSpans((prev) => {
                      const next = new Set(prev);
                      next.add(row.span.SpanId);
                      return next;
                    });
                  }
                } else {
                  onSpanSelect?.(row.span.SpanId);
                }
              }}
              onMouseMove={(e) => handleMouseMove(e, row.span.SpanId)}
              onMouseLeave={handleMouseLeave}
            >
              <div className="flex w-[500px] shrink-0 items-center border-r border-border/30 py-2 pr-4">
                <div className="flex flex-1 items-center min-w-0 pl-4 pr-3">
                  <div className="flex flex-1 items-center gap-1.5 min-w-0">
                    {/* Tree lines */}
                    {Array.from({ length: row.depth }).map((_, i) => {
                      const isLast = row.isLastPath[i];
                      const isCurrentDepth = i === row.depth - 1;
                      return (
                        <div key={i} className="relative w-4 shrink-0 self-stretch">
                          {(!isLast || isCurrentDepth) && (
                            <div
                              className={`absolute left-1/2 w-px bg-border/60 ${
                                isLast && isCurrentDepth
                                  ? 'top-[-8px] h-[calc(50%+8px)]'
                                  : 'top-[-8px] bottom-[-8px]'
                              }`}
                            />
                          )}
                          {isCurrentDepth && (
                            <div className="absolute top-1/2 left-1/2 right-0 h-px bg-border/60" />
                          )}
                        </div>
                      );
                    })}
                    {hasChildren ? (
                      <button
                        onClick={(e) => toggleExpand(row.span.SpanId, e)}
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded z-10 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground bg-card"
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
                    {(() => {
                      const label = getPrimaryLabel(row);
                      return (
                        <span
                          className={`text-xs ${label.isOperation ? 'shrink-0' : 'truncate'} ${
                            isError
                              ? 'text-red-400 font-medium'
                              : label.isOperation
                                ? 'text-teal-400 font-medium'
                                : 'text-foreground'
                          }`}
                          title={
                            label.isOperation ? `${label.originalName} — ${label.text}` : label.text
                          }
                        >
                          {label.text}
                        </span>
                      );
                    })()}
                    {isError && <AlertCircle className="ml-1 h-3 w-3 shrink-0 text-red-500" />}
                  </div>
                </div>

                {/* Data Columns — same structure for all rows */}
                <div className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {formatDuration(row.span.Duration)}
                </div>
                <div className="flex w-20 shrink-0 flex-col items-end justify-center text-right text-xs tabular-nums">
                  {row.tokens !== null ? (
                    <span className="text-muted-foreground">{formatNumber(row.tokens)}</span>
                  ) : hasChildren && row.subtreeTokens > 0 ? (
                    <span className="text-muted-foreground/60">
                      {formatNumber(row.subtreeTokens)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">-</span>
                  )}
                  {row.isCacheHit && (
                    <span className="mt-px text-[9px] font-medium leading-none uppercase text-amber-500">
                      Cache
                    </span>
                  )}
                </div>
                <div className="flex w-20 shrink-0 flex-col items-end justify-center text-right text-xs tabular-nums">
                  {row.cost !== null ? (
                    <span className="text-emerald-400/90">${row.cost.toFixed(4)}</span>
                  ) : hasChildren && row.subtreeCost > 0 ? (
                    <span className="text-emerald-400/50">${row.subtreeCost.toFixed(4)}</span>
                  ) : (
                    <span className="text-muted-foreground/40">-</span>
                  )}
                </div>
              </div>

              <div className="relative flex flex-1 items-center px-4 py-2">
                <div className="relative h-5 w-full">
                  {(() => {
                    const barHeight =
                      row.depth === 0 ? 'h-full' : row.depth === 1 ? 'h-3' : 'h-1.5';
                    const barCenter =
                      row.depth === 0 ? '' : row.depth === 1 ? 'top-[4px]' : 'top-[7px]';
                    const barOpacity =
                      row.depth === 0 ? '' : row.depth === 1 ? 'opacity-70' : 'opacity-45';
                    return (
                      <div
                        className={`absolute ${barHeight} ${barCenter} ${barOpacity} rounded transition-opacity group-hover:opacity-90 ${isHollowType(row.type) ? 'border' : ''} ${getTypeColor(
                          row.type,
                          row.span.StatusCode,
                          row.span,
                          row.depth,
                        )} ${alertStyles?.glow ?? ''} ${row.isCacheHit ? 'bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(255,255,255,0.05)_4px,rgba(255,255,255,0.05)_8px)]' : ''}`}
                        style={{
                          left: barLayout
                            ? `${barLayout.layout.get(row.span.SpanId)?.left ?? 0}%`
                            : `${row.startOffset}%`,
                          width: barLayout
                            ? `${barLayout.layout.get(row.span.SpanId)?.width ?? 0.5}%`
                            : `${row.width}%`,
                          minWidth: '4px',
                        }}
                      >
                        {alertStyles && (
                          <div
                            className={`absolute left-0 top-0 h-full w-[3px] rounded-l ${alertStyles.edge}`}
                          />
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Sticky footer */}
      <div className="sticky bottom-0 z-20 flex border-t border-border/30 bg-card/95 backdrop-blur-sm">
        <div className="w-[500px] shrink-0 border-r border-border/30" />
        <div className="relative flex h-8 flex-1 justify-between px-4 py-3">
          {timeMarkers.map((marker, i) => (
            <span
              key={i}
              className="text-[10px] tabular-nums text-muted-foreground/70"
              style={{
                position: 'absolute',
                left: `${marker.position}%`,
                transform:
                  i === 0
                    ? 'translateX(0)'
                    : i === timeMarkers.length - 1
                      ? 'translateX(-100%)'
                      : 'translateX(-50%)',
              }}
            >
              {marker.label}
            </span>
          ))}
        </div>
      </div>

      {mousePos && hoveredRow && (
        <div
          className="pointer-events-none absolute z-50 max-w-lg rounded-md bg-popover px-2.5 py-1.5 text-xs shadow-lg ring-1 ring-border/50"
          style={{
            ...(mousePos.x > mousePos.containerWidth * 0.6
              ? { right: mousePos.containerWidth - mousePos.x + 12 }
              : { left: mousePos.x + 12 }),
            ...(mousePos.y > mousePos.containerHeight * 0.7
              ? { bottom: mousePos.containerHeight - mousePos.y + 12 }
              : { top: mousePos.y + 12 }),
          }}
        >
          {(() => {
            const label = getPrimaryLabel(hoveredRow);
            return (
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`font-medium ${label.isOperation ? 'text-teal-400' : 'text-foreground'}`}
                  >
                    {label.text}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatDuration(hoveredRow.span.Duration)}
                  </span>
                </div>
                {label.isOperation && (
                  <div className="text-[10px] text-muted-foreground/60">{label.originalName}</div>
                )}
              </div>
            );
          })()}
          {childrenMap.has(hoveredRow.span.SpanId) ? (
            <>
              {hoveredRow.subtreeModels.size > 0 && (
                <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                  {[...hoveredRow.subtreeModels].map((m) => shortenModelName(m)).join(', ')}
                </div>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {hoveredRow.subtreeTokens > 0 && (
                  <span className="tabular-nums text-muted-foreground">
                    {formatNumber(hoveredRow.subtreeTokens)} tokens
                  </span>
                )}
                {hoveredRow.subtreeTps !== null && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="tabular-nums text-muted-foreground">
                      {hoveredRow.subtreeTps.toFixed(1)} tok/s avg
                    </span>
                  </>
                )}
                {hoveredRow.subtreeCost > 0 && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="tabular-nums text-emerald-400">
                      ${hoveredRow.subtreeCost.toFixed(6)}
                    </span>
                  </>
                )}
                {(childrenMap.get(hoveredRow.span.SpanId) ?? 0) > 0 && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">
                      {childrenMap.get(hoveredRow.span.SpanId)} spans
                    </span>
                  </>
                )}
              </div>
              {hoveredRow.subtreeOperations.size > 0 && (
                <div className="mt-1 text-[10px] text-teal-400">
                  {[...hoveredRow.subtreeOperations].join(', ')}
                </div>
              )}
            </>
          ) : (
            (hoveredRow.tokens !== null ||
              hoveredRow.tokensPerSecond !== null ||
              hoveredRow.cost !== null) && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {hoveredRow.tokens !== null && (
                  <span className="tabular-nums text-muted-foreground">
                    {formatNumber(hoveredRow.tokens)} tokens
                  </span>
                )}
                {hoveredRow.tokensPerSecond !== null && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="tabular-nums text-muted-foreground">
                      {hoveredRow.tokensPerSecond.toFixed(1)} tok/s
                    </span>
                  </>
                )}
                {hoveredRow.cost !== null && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="tabular-nums text-emerald-400">
                      ${hoveredRow.cost.toFixed(6)}
                    </span>
                  </>
                )}
              </div>
            )
          )}
          {Object.keys(hoveredRow.baggage).filter((k) => k !== 'operation').length > 0 && (
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
          {hoveredTriggeredAlerts.length > 0 && (
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
