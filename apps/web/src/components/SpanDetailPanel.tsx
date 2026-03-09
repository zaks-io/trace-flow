'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Clock, Hash, GitBranch, ChevronRight, ChevronDown, AlertTriangle } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  formatBodyForDisplay,
  mergeSSEEvents,
  parseMessagesFromBody,
  parseResponseBody,
  type FormattedBody,
  type ParsedSSEEvent,
  type ParsedMessage,
  type MessageBreakdownData,
} from '@trace-flow/utils';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { BarCard, type Segment, formatCompact, formatCostCompact } from '@/components/BarCard';
import { AlertList } from '@/components/alerts';
import { ModelPill } from '@/components/spans-table/ModelPill';
import { fetchStoredBodies, formatStoredBodiesForDisplay } from '@/lib/bodies';
import type { TriggeredAlert } from '@/types/alerts';
import { isLLMRequestSpan, parseSpanAttributes, type TraceSpan } from '@/lib/spans';

interface SpanDetailPanelProps {
  span: TraceSpan | null;
  rootSpan: TraceSpan | null;
  allSpans?: TraceSpan[];
  isRootSpan: boolean;
  isOpen: boolean;
  onClose: () => void;
  triggeredAlerts?: TriggeredAlert[];
}

function formatDuration(nanoseconds: number): string {
  const ms = nanoseconds / 1_000_000;
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTimestamp(nanoseconds: number): string {
  const ms = nanoseconds / 1_000_000;
  return new Date(ms).toLocaleString();
}

/**
 * Extracts content from response body for output spans (assistant text, thinking, tool_use).
 * Handles both JSON (non-streaming) and SSE (streaming) responses.
 */
function extractOutputContent(
  body: FormattedBody,
  contentType: string,
  spanName: string,
): { formatted: string; raw: object } | null {
  const match = /\.(\d+)$/.exec(spanName);
  const occurrenceNum = match ? parseInt(match[1], 10) : 1;

  let contentBlocks: {
    type: string;
    text?: string;
    thinking?: string;
    name?: string;
    input?: unknown;
  }[] = [];

  if (body.format === 'sse') {
    const events = body.content as ParsedSSEEvent[];
    const blocks = new Map<number, { type: string; text: string; name?: string; input?: string }>();

    for (const event of events) {
      if (!event.data || event.data === '[DONE]') continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (parsed.type === 'content_block_start') {
        const contentBlock = parsed.content_block as { type?: string; name?: string } | undefined;
        const index = parsed.index as number;
        if (contentBlock?.type !== undefined && index !== undefined) {
          blocks.set(index, { type: contentBlock.type, text: '', name: contentBlock.name });
        }
      }

      if (parsed.type === 'content_block_delta') {
        const index = parsed.index as number;
        const delta = parsed.delta as
          | { type?: string; text?: string; thinking?: string; partial_json?: string }
          | undefined;
        if (delta && index !== undefined && blocks.has(index)) {
          const block = blocks.get(index)!;
          if (delta.text) block.text += delta.text;
          if (delta.thinking) block.text += delta.thinking;
          if (delta.partial_json) block.input = (block.input ?? '') + delta.partial_json;
        }
      }

      const choices = parsed.choices as { delta?: { content?: string } }[] | undefined;
      if (choices?.[0]?.delta?.content) {
        if (!blocks.has(0)) blocks.set(0, { type: 'text', text: '' });
        blocks.get(0)!.text += choices[0].delta.content;
      }
    }

    contentBlocks = Array.from(blocks.entries())
      .sort(([a], [b]) => a - b)
      .map(([, block]) => {
        const result: (typeof contentBlocks)[0] = { type: block.type };
        if (block.type === 'text') result.text = block.text;
        if (block.type === 'thinking') result.thinking = block.text;
        if (block.name) result.name = block.name;
        if (block.input) {
          try {
            result.input = JSON.parse(block.input);
          } catch {
            result.input = block.input;
          }
        }
        return result;
      });
  } else if (body.format === 'json') {
    const jsonBody = body.content as {
      content?: unknown[];
      choices?: { message?: { content?: unknown } }[];
    };

    if (jsonBody.content && Array.isArray(jsonBody.content)) {
      contentBlocks = jsonBody.content as typeof contentBlocks;
    } else {
      const openaiContent = jsonBody.choices?.[0]?.message?.content;
      if (typeof openaiContent === 'string') {
        return { formatted: openaiContent, raw: { type: 'text', text: openaiContent } };
      }
    }
  }

  if (contentBlocks.length === 0) return null;

  const matchingBlocks = contentBlocks.filter((block) => block.type === contentType);
  if (occurrenceNum > matchingBlocks.length) return null;

  const block = matchingBlocks[occurrenceNum - 1];
  if (!block) return null;

  let formatted: string;
  if (block.type === 'text') {
    formatted = block.text ?? '';
  } else if (block.type === 'thinking') {
    formatted = block.thinking ?? '';
  } else if (block.type === 'tool_use') {
    formatted = `Tool: ${block.name ?? 'unknown'}\n${JSON.stringify(block.input ?? {}, null, 2)}`;
  } else {
    formatted = JSON.stringify(block, null, 2);
  }

  return { formatted, raw: block };
}

// ── Keys already shown in header / BarCard ──

const displayedKeys = new Set([
  'gen_ai.system',
  'gen_ai.request.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.input_tokens_uncached',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.reasoning_tokens',
  'gen_ai.usage.cache_read_input_tokens',
  'gen_ai.usage.cache_creation_input_tokens',
  'gen_ai.server.time_to_first_token',
  'service.name',
  'gen_ai.cost.input',
  'gen_ai.cost.output',
  'gen_ai.cost.total',
  'gen_ai.cost.cache_read',
  'gen_ai.cost.cache_creation',
  'gen_ai.cost.reasoning',
  'gen_ai.cost.prompt_baseline',
  'gen_ai.cost.cache_impact',
  'gen_ai.cost.upstream',
  'gen_ai.request_id',
  'baggage.operation',
]);

// ── Message rendering ──

const roleBadgeColors: Record<string, string> = {
  system: 'bg-purple-500/15 text-purple-400',
  user: 'bg-blue-500/15 text-blue-400',
  assistant: 'bg-green-500/15 text-green-400',
  tool: 'bg-amber-500/15 text-amber-400',
  tool_result: 'bg-amber-500/15 text-amber-400',
};

function RoleBadge({ role }: { role: string }) {
  const colorClass = roleBadgeColors[role] ?? 'bg-muted text-muted-foreground';
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${colorClass}`}
    >
      {role}
    </span>
  );
}

function MessageRow({
  message,
  totalTokens,
  maxTokens,
  isExpanded,
  onToggle,
}: {
  message: ParsedMessage;
  totalTokens: number;
  maxTokens: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const percentage = totalTokens > 0 ? (message.estimatedTokens / totalTokens) * 100 : 0;
  const barWidth = maxTokens > 0 ? (message.estimatedTokens / maxTokens) * 100 : 0;
  const barColor =
    percentage > 75
      ? 'bg-red-500'
      : percentage > 50
        ? 'bg-orange-500'
        : percentage > 25
          ? 'bg-yellow-500'
          : 'bg-emerald-500';
  const showWarning = percentage > 50;

  return (
    <div className="space-y-1 rounded-lg border border-border/30 bg-muted/10 p-2">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left transition-opacity hover:opacity-80"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`}
        />
        <RoleBadge role={message.role} />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">
          {message.contentPreview}
        </span>
        {showWarning && <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />}
        <span className="shrink-0 text-xs text-muted-foreground">
          ~{message.estimatedTokens.toLocaleString()} ({percentage.toFixed(0)}%)
        </span>
      </button>
      <div className="ml-5 h-1 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${barColor} rounded-full`} style={{ width: `${barWidth}%` }} />
      </div>
      {isExpanded && (
        <pre className="ml-5 mt-2 max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded border border-border/20 bg-zinc-950 p-2 text-xs text-zinc-300">
          {message.content}
        </pre>
      )}
    </div>
  );
}

// ── Body content (request/response) ──

function BodyContent({
  title,
  data,
  rawBody,
  loading,
  isSse,
}: {
  title: 'Request' | 'Response';
  data: MessageBreakdownData | null;
  rawBody: FormattedBody | null;
  loading: boolean;
  isSse?: boolean;
}) {
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(new Set());
  const [viewMode, setViewMode] = useState<'breakdown' | 'raw'>('breakdown');

  const toggleExpanded = (index: number) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const maxTokens = data ? Math.max(...data.messages.map((m) => m.estimatedTokens), 0) : 0;
  const highTokenMessages = data
    ? data.messages.filter(
        (m) => data.totalEstimatedTokens > 0 && m.estimatedTokens / data.totalEstimatedTokens > 0.5,
      ).length
    : 0;

  const renderRawContent = () => {
    if (!rawBody) {
      return (
        <div className="rounded-lg border border-dashed border-border/50 bg-muted/10 p-4 text-center">
          <p className="text-sm text-muted-foreground">Content not available</p>
        </div>
      );
    }

    const content =
      rawBody.format === 'sse'
        ? rawBody.raw
        : rawBody.format === 'json'
          ? JSON.stringify(rawBody.content, null, 2)
          : typeof rawBody.content === 'object'
            ? JSON.stringify(rawBody.content, null, 2)
            : String(rawBody.content);

    return (
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/30 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300">
        {content}
      </pre>
    );
  };

  return (
    <div className="space-y-2">
      {/* Header row with title + badges + toggle */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {isSse && (
          <span className="rounded-full bg-purple-500/15 px-2 py-0.5 text-[10px] font-medium text-purple-400">
            SSE
          </span>
        )}
        {data && (
          <>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {data.messages.length} {data.messages.length === 1 ? 'message' : 'messages'}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              ~{data.totalEstimatedTokens.toLocaleString()} tokens
            </span>
            {highTokenMessages > 0 && (
              <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                <AlertTriangle className="h-3 w-3" />
                {highTokenMessages} high
              </span>
            )}
          </>
        )}
        <div className="flex-1" />
        <div className="flex gap-1">
          <button
            onClick={() => setViewMode('breakdown')}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
              viewMode === 'breakdown'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            }`}
          >
            Breakdown
          </button>
          <button
            onClick={() => setViewMode('raw')}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
              viewMode === 'raw'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            }`}
          >
            Raw
          </button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10 py-6">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        </div>
      ) : viewMode === 'breakdown' ? (
        data ? (
          <div className="space-y-1.5">
            {data.messages.map((msg) => (
              <MessageRow
                key={msg.index}
                message={msg}
                totalTokens={data.totalEstimatedTokens}
                maxTokens={maxTokens}
                isExpanded={expandedMessages.has(msg.index)}
                onToggle={() => toggleExpanded(msg.index)}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/50 bg-muted/10 p-4 text-center">
            <p className="text-sm text-muted-foreground">
              Unable to parse {title.toLowerCase()} content
            </p>
          </div>
        )
      ) : (
        renderRawContent()
      )}
    </div>
  );
}

// ── Segment builder for single-span token data ──

const SEGMENT_CONFIG = {
  input: { label: 'Input', color: 'var(--color-chart-4)' },
  cacheRead: { label: 'Cache Read', color: 'var(--color-chart-3)' },
  cacheWrite: { label: 'Cache Write', color: 'var(--color-chart-2)' },
  output: { label: 'Output', color: 'var(--color-chart-1)' },
  reasoning: { label: 'Reasoning', color: 'var(--color-chart-5)' },
} as const;

type SegmentKey = keyof typeof SEGMENT_CONFIG;
const SEGMENT_ORDER: SegmentKey[] = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'];

function buildTokenSegments(values: Record<SegmentKey, number>): Segment[] {
  return SEGMENT_ORDER.filter((key) => values[key] > 0).map((key) => ({
    key,
    label: SEGMENT_CONFIG[key].label,
    value: values[key],
    color: SEGMENT_CONFIG[key].color,
  }));
}

// ── Copyable metadata value ──

function CopyableValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const truncated = value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  return (
    <button
      onClick={() => void handleCopy()}
      className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      title={`${label}: ${value} (click to copy)`}
    >
      {label === 'Span' && <Hash className="h-3 w-3" />}
      {label === 'Parent' && <GitBranch className="h-3 w-3" />}
      {label === 'Time' && <Clock className="h-3 w-3" />}
      <span className="font-mono">{copied ? 'Copied!' : truncated}</span>
    </button>
  );
}

// ── Main component ──

export function SpanDetailPanel({
  span,
  rootSpan: _rootSpan,
  allSpans: _allSpans = [],
  isRootSpan,
  isOpen,
  onClose,
  triggeredAlerts = [],
}: SpanDetailPanelProps) {
  const [requestBody, setRequestBody] = useState<FormattedBody | null>(null);
  const [responseBody, setResponseBody] = useState<FormattedBody | null>(null);
  const [bodiesLoading, setBodiesLoading] = useState(false);
  const [messageContent, setMessageContent] = useState<{
    formatted: string;
    raw: object;
  } | null>(null);
  const [messageContentLoading, setMessageContentLoading] = useState(false);
  const [messageTab, setMessageTab] = useState<'formatted' | 'raw'>('formatted');
  const [isEventsOpen, setIsEventsOpen] = useState(false);

  const spanAttributes = useMemo(
    () => (span ? parseSpanAttributes(span.SpanAttributes) : {}),
    [span],
  );
  const resourceAttributes = useMemo(
    () => (span?.ResourceAttributes ? parseSpanAttributes(span.ResourceAttributes) : {}),
    [span],
  );
  const allAttributes = useMemo(
    () => ({ ...spanAttributes, ...resourceAttributes }),
    [spanAttributes, resourceAttributes],
  );

  const provider = allAttributes['gen_ai.system'] ?? '';
  const model = allAttributes['gen_ai.request.model'] ?? '';
  const operation = allAttributes['baggage.operation'] ?? '';

  // Token data
  const promptTokens = parseInt(allAttributes['gen_ai.usage.input_tokens'] ?? '0', 10);
  const completionTokens = parseInt(allAttributes['gen_ai.usage.output_tokens'] ?? '0', 10);
  const reasoningTokens = parseInt(allAttributes['gen_ai.usage.reasoning_tokens'] ?? '0', 10);
  const cacheReadTokens = parseInt(
    allAttributes['gen_ai.usage.cache_read_input_tokens'] ?? '0',
    10,
  );
  const cacheWriteTokens = parseInt(
    allAttributes['gen_ai.usage.cache_creation_input_tokens'] ?? '0',
    10,
  );
  const ttftMs = allAttributes['gen_ai.server.time_to_first_token']
    ? parseFloat(allAttributes['gen_ai.server.time_to_first_token'])
    : null;
  // Cost breakdown
  const costInput = allAttributes['gen_ai.cost.input']
    ? parseFloat(allAttributes['gen_ai.cost.input'])
    : 0;
  const costOutput = allAttributes['gen_ai.cost.output']
    ? parseFloat(allAttributes['gen_ai.cost.output'])
    : 0;
  const costCacheRead = allAttributes['gen_ai.cost.cache_read']
    ? parseFloat(allAttributes['gen_ai.cost.cache_read'])
    : 0;
  const costCacheWrite = allAttributes['gen_ai.cost.cache_creation']
    ? parseFloat(allAttributes['gen_ai.cost.cache_creation'])
    : 0;
  const costReasoning = allAttributes['gen_ai.cost.reasoning']
    ? parseFloat(allAttributes['gen_ai.cost.reasoning'])
    : 0;
  const costPromptBaseline = allAttributes['gen_ai.cost.prompt_baseline']
    ? parseFloat(allAttributes['gen_ai.cost.prompt_baseline'])
    : 0;
  const costCacheImpact = allAttributes['gen_ai.cost.cache_impact']
    ? parseFloat(allAttributes['gen_ai.cost.cache_impact'])
    : 0;
  const costUpstream = allAttributes['gen_ai.cost.upstream']
    ? parseFloat(allAttributes['gen_ai.cost.upstream'])
    : 0;
  const costTotal = costInput + costOutput + costCacheRead + costCacheWrite + costReasoning;

  const inputTokens = allAttributes['gen_ai.usage.input_tokens_uncached']
    ? parseInt(allAttributes['gen_ai.usage.input_tokens_uncached'], 10)
    : Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const totalTokens =
    inputTokens + cacheReadTokens + cacheWriteTokens + completionTokens + reasoningTokens;

  const tokenSegments = useMemo(
    () =>
      buildTokenSegments({
        input: inputTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        output: completionTokens,
        reasoning: reasoningTokens,
      }),
    [inputTokens, cacheReadTokens, cacheWriteTokens, completionTokens, reasoningTokens],
  );

  const costSegments = useMemo(
    () =>
      buildTokenSegments({
        input: costInput,
        cacheRead: costCacheRead,
        cacheWrite: costCacheWrite,
        output: costOutput,
        reasoning: costReasoning,
      }),
    [costInput, costCacheRead, costCacheWrite, costOutput, costReasoning],
  );

  const remainingAttributes = Object.entries(allAttributes).filter(
    ([key]) => !displayedKeys.has(key),
  );

  // Output span detection
  const isOutputSpan =
    span?.SpanName.match(/^gen_ai\.response\.(text|thinking|tool_use)/i) !== null;
  const contentType = (() => {
    const attrType = spanAttributes['gen_ai.content.type'];
    if (attrType) return attrType;
    const spanMatch = span?.SpanName.match(/^gen_ai\.response\.(text|thinking|tool_use)/i);
    return spanMatch?.[1]?.toLowerCase() ?? '';
  })();

  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortControllerRef.current?.abort();

    if (!span || !isOpen) {
      setRequestBody(null);
      setResponseBody(null);
      setMessageContent(null);
      return;
    }

    const attrs = parseSpanAttributes(span.SpanAttributes);
    const requestId = attrs['gen_ai.request_id'];
    if (!requestId) return;

    const isLLMRoot = isRootSpan && isLLMRequestSpan(span);
    const isOutput = isOutputSpan && span.ParentSpanId !== '';
    if (!isLLMRoot && !isOutput) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const { signal } = controller;

    setRequestBody(null);
    setResponseBody(null);
    setMessageContent(null);

    const run = async () => {
      if (isLLMRoot) {
        setBodiesLoading(true);
      } else {
        setMessageContentLoading(true);
      }

      const tokenRes = await fetch('/api/token', { signal });
      if (!tokenRes.ok) {
        if (isLLMRoot) {
          setBodiesLoading(false);
          window.location.href = `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
        } else {
          setMessageContentLoading(false);
        }
        return;
      }
      const { token } = await tokenRes.json();

      const storedBodies = await fetchStoredBodies(requestId, token, signal);
      if (signal.aborted) return;

      if (isLLMRoot) {
        const formattedBodies = formatStoredBodiesForDisplay(storedBodies);
        setRequestBody(formattedBodies.requestBody);
        setResponseBody(formattedBodies.responseBody);
        setBodiesLoading(false);
      } else {
        const responseBody = formatBodyForDisplay(storedBodies?.responseBody ?? null);
        if (responseBody) {
          setMessageContent(extractOutputContent(responseBody, contentType, span.SpanName));
        }
        setMessageContentLoading(false);
      }
    };

    void run().catch(() => {
      if (signal.aborted) return;
      setBodiesLoading(false);
      setMessageContentLoading(false);
    });

    return () => controller.abort();
  }, [span, isRootSpan, isOpen, isOutputSpan, contentType]);

  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent
        side="right"
        className="flex w-[680px] flex-col overflow-hidden p-0 sm:max-w-[680px]"
      >
        {/* ── Header ── */}
        <SheetHeader className="flex-shrink-0 space-y-2 border-b border-border/50 p-4">
          <div className="pr-8">
            <SheetTitle className="text-base font-medium text-foreground">
              {span?.SpanName ?? 'Span Details'}
            </SheetTitle>
            <SheetDescription className="mt-0.5 flex items-center gap-2 text-xs">
              {span && (
                <>
                  <span className="tabular-nums">{formatDuration(span.Duration)}</span>
                  <span className="text-border">·</span>
                  <span
                    className={span.StatusCode === 'ERROR' ? 'text-red-400' : 'text-emerald-400'}
                  >
                    {span.StatusCode}
                  </span>
                  {operation && (
                    <>
                      <span className="text-border">·</span>
                      <span className="rounded bg-teal-500/15 px-1.5 py-0.5 text-[10px] font-medium text-teal-400">
                        {operation}
                      </span>
                    </>
                  )}
                </>
              )}
            </SheetDescription>
          </div>

          {/* Model + Provider */}
          {model && (
            <div className="flex items-center gap-2">
              <ModelPill model={model} provider={provider ?? undefined} />
            </div>
          )}

          {/* Metadata line */}
          {span && (
            <div className="flex items-center gap-3">
              <CopyableValue label="Span" value={span.SpanId} />
              {span.ParentSpanId && span.ParentSpanId !== '' && (
                <>
                  <span className="text-border">·</span>
                  <CopyableValue label="Parent" value={span.ParentSpanId} />
                </>
              )}
              <span className="text-border">·</span>
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock className="h-3 w-3" />
                {formatTimestamp(span.Timestamp)}
              </span>
            </div>
          )}
        </SheetHeader>

        {/* ── Scrollable content ── */}
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {span && (
            <>
              {/* Alerts */}
              {triggeredAlerts.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-foreground">Triggered Alerts</h4>
                  <AlertList triggeredAlerts={triggeredAlerts} />
                </div>
              )}

              {/* Token + Cost BarCards + stat badges */}
              {(totalTokens > 0 || costTotal > 0) && (
                <div className="space-y-2">
                  <div
                    className={`grid gap-2 ${costTotal > 0 && totalTokens > 0 ? 'grid-cols-2' : 'grid-cols-1'}`}
                  >
                    {totalTokens > 0 && (
                      <BarCard
                        label="Tokens"
                        value={formatCompact(totalTokens)}
                        segments={tokenSegments}
                        total={totalTokens}
                        accent="from-chart-3/20 to-chart-3/5"
                        formatter={formatCompact}
                        compact
                      />
                    )}
                    {costTotal > 0 && (
                      <BarCard
                        label="Cost"
                        value={formatCostCompact(costTotal)}
                        segments={costSegments}
                        total={costTotal}
                        accent="from-chart-7/20 to-chart-7/5"
                        formatter={formatCostCompact}
                        compact
                      />
                    )}
                  </div>
                  {(ttftMs !== null ||
                    costPromptBaseline > 0 ||
                    costCacheImpact !== 0 ||
                    costUpstream > 0) && (
                    <div className="flex flex-wrap gap-1.5">
                      {ttftMs !== null && (
                        <Badge variant="outline" className="font-mono text-[11px]">
                          TTFT {ttftMs.toFixed(0)}ms
                        </Badge>
                      )}
                      {costPromptBaseline > 0 && (
                        <Badge variant="outline" className="font-mono text-[11px]">
                          Baseline {formatCostCompact(costPromptBaseline)}
                        </Badge>
                      )}
                      {costCacheImpact !== 0 && (
                        <Badge variant="outline" className="font-mono text-[11px]">
                          Impact {formatCostCompact(costCacheImpact)}
                        </Badge>
                      )}
                      {costUpstream > 0 && (
                        <Badge variant="outline" className="font-mono text-[11px]">
                          Upstream {formatCostCompact(costUpstream)}
                        </Badge>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Request / Response bodies (always visible for LLM request spans) */}
              {isRootSpan && span && isLLMRequestSpan(span) && (
                <>
                  <BodyContent
                    title="Request"
                    data={
                      requestBody?.format === 'json'
                        ? parseMessagesFromBody(requestBody.content, provider)
                        : null
                    }
                    rawBody={requestBody}
                    loading={bodiesLoading}
                  />
                  <BodyContent
                    title="Response"
                    data={(() => {
                      if (!responseBody) return null;
                      if (responseBody.format === 'json') {
                        return parseResponseBody(responseBody.content, provider);
                      }
                      if (responseBody.format === 'sse') {
                        const merged = mergeSSEEvents(responseBody.content as ParsedSSEEvent[]);
                        return parseResponseBody(merged, provider);
                      }
                      return null;
                    })()}
                    rawBody={responseBody}
                    loading={bodiesLoading}
                    isSse={responseBody?.format === 'sse'}
                  />
                </>
              )}

              {/* Output content (for output spans) */}
              {isOutputSpan && !isRootSpan && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">Output Content</span>
                    <div className="flex-1" />
                    <div className="flex gap-1">
                      <button
                        onClick={() => setMessageTab('formatted')}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          messageTab === 'formatted'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        Formatted
                      </button>
                      <button
                        onClick={() => setMessageTab('raw')}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          messageTab === 'raw'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        Raw
                      </button>
                    </div>
                  </div>

                  {messageContentLoading ? (
                    <div className="flex items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10 py-6">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                    </div>
                  ) : messageContent ? (
                    messageTab === 'formatted' ? (
                      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/30 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300">
                        {messageContent.formatted}
                      </pre>
                    ) : (
                      <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border/30 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300">
                        {JSON.stringify(messageContent.raw, null, 2)}
                      </pre>
                    )
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/50 bg-muted/10 p-4 text-center">
                      <p className="text-sm text-muted-foreground">Content not available</p>
                      <p className="mt-1 text-xs text-muted-foreground/70">
                        This may occur in multi-turn conversations where this message belongs to a
                        different request cycle.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Attributes as badge pills */}
              {remainingAttributes.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Attributes
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {remainingAttributes.map(([key, value]) => (
                      <Badge
                        key={key}
                        variant="outline"
                        className="max-w-[300px] truncate font-mono text-[10px]"
                        title={`${key}: ${value}`}
                      >
                        <span className="text-muted-foreground">{key}:</span> {value}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Events (collapsed by default) */}
              {span['Events.Name'] && span['Events.Name'].length > 0 && (
                <Collapsible open={isEventsOpen} onOpenChange={setIsEventsOpen}>
                  <CollapsibleTrigger className="flex items-center gap-2 text-left transition-colors hover:opacity-70">
                    <ChevronDown
                      className={`h-4 w-4 text-muted-foreground transition-transform ${isEventsOpen ? 'rotate-0' : '-rotate-90'}`}
                    />
                    <span className="text-sm font-medium text-foreground">Events</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {span['Events.Name'].length}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2 space-y-1.5 rounded-lg border border-border/30 bg-muted/10 p-2">
                      {span['Events.Name'].map((name, index) => {
                        const attrsJson = span['Events.Attributes']?.[index];
                        const attrs = attrsJson ? parseSpanAttributes(attrsJson) : {};
                        const hasAttrs = Object.keys(attrs).length > 0;
                        const timestamp = span['Events.Timestamp']?.[index];

                        return (
                          <div key={index} className="border-l-2 border-primary/50 py-1 pl-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-foreground">{name}</span>
                              {timestamp && (
                                <span className="text-[10px] text-muted-foreground">
                                  {formatTimestamp(timestamp)}
                                </span>
                              )}
                            </div>
                            {hasAttrs && (
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                {Object.entries(attrs).map(([key, value]) => (
                                  <span
                                    key={key}
                                    className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                  >
                                    {key}: {value}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
