import type { ElementType } from 'react';
import type { TraceSpanRow } from '@trace-flow/spans';
import {
  GEN_AI,
  GEN_AI_COST,
  GEN_AI_USAGE,
  SPAN_NAME_PREFIXES,
  SPAN_NAMES,
} from '@trace-flow/otel-conventions';
import { formatDuration as formatDurationMs } from '@/lib/format';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowLeftRight,
  Bot,
  Brain,
  FileText,
  Info,
  Layers,
  MessageCircle,
  Play,
  Send,
  Settings2,
  User,
} from 'lucide-react';
import type { AlertSeverity, TraceAlertSummary } from '@/types/alerts';

export type TraceSpan = Pick<
  TraceSpanRow,
  | 'Timestamp'
  | 'TraceId'
  | 'SpanId'
  | 'SpanName'
  | 'ServiceName'
  | 'Duration'
  | 'StatusCode'
  | 'SpanAttributes'
> & {
  ParentSpanId: string;
};

export interface AgentGanttChartProps {
  spans: TraceSpan[];
  selectedSpanId?: string;
  onSpanSelect?: (spanId: string) => void;
  parentSpanId?: string;
  spanAlertSummary?: Map<string, TraceAlertSummary>;
}

export const alertSeverityStyles: Record<
  AlertSeverity,
  { edge: string; glow: string; icon: ElementType; text: string }
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

export type SpanType =
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

export type TimelineMode = 'duration' | 'tokens' | 'cost';

export interface SpanRow {
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

export function getSpanModel(attrs: Record<string, string>): string | null {
  const raw =
    [attrs[GEN_AI.REQUEST_MODEL], attrs['llm.request.model'], attrs[GEN_AI.SYSTEM]].find((value) =>
      Boolean(value),
    ) ?? null;
  if (!raw) return null;
  const provider = attrs[GEN_AI.SYSTEM];
  if (!provider) return raw;
  const name = raw.includes('/') ? raw.split('/').slice(1).join('/') : raw;
  return `${provider}/${name}`;
}

export function shortenModelName(model: string): string {
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

export function getPrimaryLabel(row: SpanRow): {
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

export function getSpanType(span: TraceSpan, attrs: Record<string, string>): SpanType {
  // Synthetic grouping spans
  if (attrs.synthetic === 'true') return 'synthetic';

  const name = span.SpanName.toLowerCase();

  // OTel GenAI semantic conventions: span names like "chat gpt-4", "embeddings text-embedding-3-small"
  // Also check gen_ai.operation.name attribute for new-style spans
  const operationName = attrs[GEN_AI.OPERATION_NAME]?.toLowerCase();
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
  if (name.startsWith(SPAN_NAMES.responseFor('text'))) return 'assistant_text';
  if (name.startsWith(SPAN_NAMES.responseFor('thinking'))) return 'assistant_thinking';
  if (name.startsWith(SPAN_NAMES.responseFor('tool_use'))) return 'assistant_tool_use';

  // Tool execution
  if (name === SPAN_NAMES.TOOL_EXECUTION) return 'tool_execution';

  // Fallback for other response outputs (numbered variants like gen_ai.response.text.2)
  if (name.startsWith(SPAN_NAME_PREFIXES.RESPONSE)) return 'assistant_text';

  return 'internal';
}

export function getSpanTokens(attrs: Record<string, string>): number | null {
  const input = parseInt(attrs[GEN_AI_USAGE.INPUT_TOKENS] ?? '0', 10);
  const output = parseInt(attrs[GEN_AI_USAGE.OUTPUT_TOKENS] ?? '0', 10);
  const total = input + output;

  return total > 0 ? total : null;
}

export function getSpanTokensPerSecond(
  _span: TraceSpan,
  attrs: Record<string, string>,
): number | null {
  const tps = attrs[GEN_AI.TOKENS_PER_SECOND];
  return tps ? parseFloat(tps) : null;
}

export function getSpanCost(attrs: Record<string, string>): number | null {
  const cost = attrs[GEN_AI_COST.TOTAL];
  return cost ? parseFloat(cost) : null;
}

export function getBaggageAttributes(attrs: Record<string, string>): Record<string, string> {
  const baggage: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('baggage.')) {
      baggage[key.replace('baggage.', '')] = value;
    }
  }
  return baggage;
}

export function getMessageIndex(attrs: Record<string, string>): number | null {
  const index = attrs[GEN_AI.MESSAGE_INDEX];
  return index !== undefined ? parseInt(index, 10) : null;
}

export function getOperationName(attrs: Record<string, string>): string | null {
  const operationName = attrs[GEN_AI.OPERATION_NAME];
  if (!operationName) return null;
  return operationName;
}

export function isHollowType(type: SpanType): boolean {
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

export function getTypeColor(
  type: SpanType,
  status: string,
  span?: TraceSpan,
  depth?: number,
): string {
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

export function getTypeIcon(type: SpanType) {
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

export function getTypeIconColor(type: SpanType, span?: TraceSpan): string {
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

export function formatDuration(nanoseconds: number): string {
  return formatDurationMs(nanoseconds / 1_000_000);
}

export function getAdaptiveInterval(totalDurationNs: number): number {
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

export function getMetricInterval(maxValue: number): number {
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
