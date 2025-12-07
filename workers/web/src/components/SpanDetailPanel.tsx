import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import {
  Clock,
  Hash,
  Globe,
  Server,
  Cpu,
  MessageSquare,
  Zap,
  GitBranch,
  DollarSign,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import {
  formatBodyForDisplay,
  mergeSSEEvents,
  type FormattedBody,
  type ParsedSSEEvent,
} from '@trace-flow/utils';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

interface TraceSpan {
  Timestamp: number;
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  SpanName: string;
  ServiceName: string;
  Duration: number;
  StatusCode: string;
  StatusMessage: string;
  SpanAttributes: string;
  ResourceAttributes: string;
  'Events.Timestamp': number[];
  'Events.Name': string[];
  'Events.Attributes': string[];
}

interface SpanDetailPanelProps {
  span: TraceSpan | null;
  rootSpan: TraceSpan | null;
  isRootSpan: boolean;
  isOpen: boolean;
  onClose: () => void;
}

function parseAttributes(attributesJson: string): Record<string, string> {
  try {
    return JSON.parse(attributesJson) as Record<string, string>;
  } catch {
    return {};
  }
}

function formatDuration(nanoseconds: number): string {
  const ms = nanoseconds / 1_000_000;
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}μs`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(2)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTimestamp(nanoseconds: number): string {
  const ms = nanoseconds / 1_000_000;
  return new Date(ms).toLocaleString();
}

function formatNumber(num: number): string {
  return new Intl.NumberFormat().format(num);
}

/**
 * Formats message content for display. Handles various message content formats:
 * - Simple strings
 * - Arrays of content blocks (multimodal: text, images, tool_use, tool_result)
 * - Objects with nested content
 */
function formatMessageForDisplay(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    // Handle array of content blocks (e.g., Anthropic multimodal format)
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (typeof block !== 'object' || block === null) return JSON.stringify(block);

        const typedBlock = block as { type?: string; text?: string; [key: string]: unknown };
        if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
          return typedBlock.text;
        }
        if (typedBlock.type === 'image' || typedBlock.type === 'image_url') {
          return '[Image]';
        }
        if (typedBlock.type === 'tool_use') {
          return `[Tool Call: ${(typedBlock as { name?: string }).name ?? 'unknown'}]`;
        }
        if (typedBlock.type === 'tool_result') {
          const result = (typedBlock as { content?: unknown }).content;
          if (typeof result === 'string') return result;
          return JSON.stringify(result, null, 2);
        }
        return JSON.stringify(block, null, 2);
      })
      .join('\n\n');
  }

  // For objects or other types, stringify
  return JSON.stringify(content, null, 2);
}

/**
 * Extracts a message from the request body using provider-aware logic.
 * - Anthropic: system prompt is in separate `system` field, messages array starts after that
 * - OpenAI/Groq/OpenRouter: all messages in `messages[]` array with direct index mapping
 */
function extractMessageFromBody(
  body: object,
  messageIndex: number,
  provider: string,
): { formatted: string; raw: object } | null {
  // Anthropic: system is separate, messages array starts at index 1 (if system exists)
  if (provider === 'anthropic') {
    const anthropicBody = body as {
      system?: string | { type: string; text?: string }[];
      messages?: { role: string; content: unknown }[];
    };

    if (messageIndex === 0 && anthropicBody.system) {
      // Index 0 = system prompt (separate field in Anthropic)
      const systemContent =
        typeof anthropicBody.system === 'string'
          ? anthropicBody.system
          : anthropicBody.system.map((b) => b.text ?? '').join('\n');
      return {
        formatted: systemContent,
        raw: { role: 'system', content: anthropicBody.system },
      };
    }

    // For non-zero indices, offset by 1 if system exists
    const offset = anthropicBody.system ? 1 : 0;
    const messages = anthropicBody.messages ?? [];
    const actualIndex = messageIndex - offset;

    if (actualIndex < 0 || actualIndex >= messages.length) {
      return null;
    }
    const msg = messages[actualIndex];
    return {
      formatted: formatMessageForDisplay(msg.content),
      raw: msg,
    };
  }

  // OpenAI/Groq/OpenRouter: direct index mapping
  const openaiBody = body as {
    messages?: { role: string; content: unknown }[];
  };
  const messages = openaiBody.messages ?? [];

  if (messageIndex >= messages.length) {
    return null;
  }
  const msg = messages[messageIndex];
  return {
    formatted: formatMessageForDisplay(msg.content),
    raw: msg,
  };
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
  // Parse the occurrence number from span name (e.g., "ai.assistant.text.2" → 2)
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
    // For SSE responses, parse Anthropic content blocks from events
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

      // Handle content_block_start - defines block type
      if (parsed.type === 'content_block_start') {
        const contentBlock = parsed.content_block as { type?: string; name?: string } | undefined;
        const index = parsed.index as number;
        if (contentBlock?.type !== undefined && index !== undefined) {
          blocks.set(index, {
            type: contentBlock.type,
            text: '',
            name: contentBlock.name,
          });
        }
      }

      // Handle content_block_delta - accumulate content
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

      // Handle OpenAI format: choices[].delta.content
      const choices = parsed.choices as { delta?: { content?: string } }[] | undefined;
      if (choices?.[0]?.delta?.content) {
        if (!blocks.has(0)) {
          blocks.set(0, { type: 'text', text: '' });
        }
        blocks.get(0)!.text += choices[0].delta.content;
      }
    }

    // Convert map to array
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
    // For JSON responses, extract content directly
    const jsonBody = body.content as {
      content?: unknown[];
      choices?: { message?: { content?: unknown } }[];
    };

    // Try Anthropic format first
    if (jsonBody.content && Array.isArray(jsonBody.content)) {
      contentBlocks = jsonBody.content as typeof contentBlocks;
    } else {
      // Try OpenAI format
      const openaiContent = jsonBody.choices?.[0]?.message?.content;
      if (typeof openaiContent === 'string') {
        return {
          formatted: openaiContent,
          raw: { type: 'text', text: openaiContent },
        };
      }
    }
  }

  if (contentBlocks.length === 0) {
    return null;
  }

  // Find blocks of the matching type
  const matchingBlocks = contentBlocks.filter((block) => block.type === contentType);

  if (occurrenceNum > matchingBlocks.length) {
    return null;
  }

  const block = matchingBlocks[occurrenceNum - 1];
  if (!block) {
    return null;
  }

  // Format the content based on type
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

interface AttributeCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}

function AttributeCard({ icon, label, value, mono = false }: AttributeCardProps) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
      <div className="mt-0.5 text-muted-foreground/60">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          {label}
        </div>
        <div
          className={`truncate text-sm text-foreground ${mono ? 'font-mono' : ''}`}
          title={value}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

export function SpanDetailPanel({
  span,
  rootSpan,
  isRootSpan,
  isOpen,
  onClose,
}: SpanDetailPanelProps) {
  const { getAccessTokenSilently } = useAuth0();
  const [requestBody, setRequestBody] = useState<FormattedBody | null>(null);
  const [responseBody, setResponseBody] = useState<FormattedBody | null>(null);
  const [requestBodyLoading, setRequestBodyLoading] = useState(false);
  const [responseBodyLoading, setResponseBodyLoading] = useState(false);
  const [isRequestOpen, setIsRequestOpen] = useState(true);
  const [isResponseOpen, setIsResponseOpen] = useState(true);
  const [isEventsOpen, setIsEventsOpen] = useState(true);
  const [isAttributesOpen, setIsAttributesOpen] = useState(false);
  const [isMergedView, setIsMergedView] = useState(true);
  const [messageContent, setMessageContent] = useState<{
    formatted: string;
    raw: object;
  } | null>(null);
  const [messageContentLoading, setMessageContentLoading] = useState(false);
  const [messageTab, setMessageTab] = useState<'formatted' | 'raw'>('formatted');
  const [isMessageOpen, setIsMessageOpen] = useState(true);

  const spanAttributes = span ? parseAttributes(span.SpanAttributes) : {};
  const resourceAttributes = span ? parseAttributes(span.ResourceAttributes) : {};
  const allAttributes = { ...spanAttributes, ...resourceAttributes };

  const provider = allAttributes['ai.provider'] ?? allAttributes['gen_ai.system'] ?? '';
  const model = allAttributes['ai.model'] ?? allAttributes['gen_ai.request.model'] ?? '';
  const promptTokens =
    parseInt(allAttributes['ai.tokens.prompt'] ?? '0', 10) ||
    parseInt(allAttributes['ai.tokens.input'] ?? '0', 10) ||
    parseInt(allAttributes['gen_ai.usage.input_tokens'] ?? '0', 10);
  const completionTokens =
    parseInt(allAttributes['ai.tokens.completion'] ?? '0', 10) ||
    parseInt(allAttributes['ai.tokens.output'] ?? '0', 10) ||
    parseInt(allAttributes['gen_ai.usage.output_tokens'] ?? '0', 10);
  const ttftMs = allAttributes['ai.time_to_first_token_ms']
    ? parseFloat(allAttributes['ai.time_to_first_token_ms'])
    : null;
  const totalCost = allAttributes['ai.cost.total']
    ? parseFloat(allAttributes['ai.cost.total'])
    : null;

  const displayedKeys = new Set([
    'ai.provider',
    'gen_ai.system',
    'ai.model',
    'gen_ai.request.model',
    'ai.tokens.prompt',
    'ai.tokens.input',
    'ai.tokens.completion',
    'ai.tokens.output',
    'ai.tokens.total',
    'ai.time_to_first_token_ms',
    'gen_ai.usage.input_tokens',
    'gen_ai.usage.output_tokens',
    'service.name',
    'ai.cost.input',
    'ai.cost.output',
    'ai.cost.total',
    'ai.cost.cache_read',
    'ai.cost.cache_creation',
    'ai.cost.reasoning',
  ]);
  const remainingAttributes = Object.entries(allAttributes).filter(
    ([key]) => !displayedKeys.has(key),
  );

  useEffect(() => {
    if (!isRootSpan || !span) return;

    // Extract requestId from span attributes - bodies are stored by requestId not traceId
    const attrs = parseAttributes(span.SpanAttributes);
    const requestId = attrs['ai.request_id'];
    if (!requestId) {
      // No requestId means body not available (e.g., OTLP traces from external systems)
      return;
    }

    const fetchBodies = async () => {
      try {
        const { id_token } = await getAccessTokenSilently({ detailedResponse: true });
        const apiUrl = import.meta.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8788';

        setRequestBodyLoading(true);
        setResponseBodyLoading(true);

        const [reqRes, resRes] = await Promise.all([
          fetch(`${apiUrl}/bodies/${requestId}/request`, {
            headers: { Authorization: `Bearer ${id_token}` },
          }),
          fetch(`${apiUrl}/bodies/${requestId}/response`, {
            headers: { Authorization: `Bearer ${id_token}` },
          }),
        ]);

        if (reqRes.ok) {
          const text = await reqRes.text();
          setRequestBody(formatBodyForDisplay(text));
        }
        if (resRes.ok) {
          const text = await resRes.text();
          setResponseBody(formatBodyForDisplay(text));
        }
      } catch {
        // Silently handle errors
      } finally {
        setRequestBodyLoading(false);
        setResponseBodyLoading(false);
      }
    };

    void fetchBodies();
  }, [isRootSpan, span, getAccessTokenSilently]);

  // Check if this is an input message span (from request)
  // Matches: ai.request.system, ai.request.user, ai.request.assistant, ai.request.tool_result
  const isInputMessageSpan =
    span?.SpanName.match(/^ai\.request\.(system|user|assistant|tool_result)/i) !== null;

  // Check if this is an output span (from response)
  // Matches: ai.response.text, ai.response.thinking, ai.response.tool_use (with optional numeric suffix)
  const isOutputSpan = span?.SpanName.match(/^ai\.response\.(text|thinking|tool_use)/i) !== null;

  const messageIndex = spanAttributes['ai.message.index']
    ? parseInt(spanAttributes['ai.message.index'], 10)
    : null;

  // Get content type from attribute, or infer from span name
  const contentType = (() => {
    const attrType = spanAttributes['ai.content.type'];
    if (attrType) return attrType;
    // Infer from span name (e.g., "ai.response.text.2" → "text")
    const spanMatch = span?.SpanName.match(/^ai\.response\.(text|thinking|tool_use)/i);
    return spanMatch?.[1]?.toLowerCase() ?? '';
  })();

  // Fetch message content for non-root spans (both input and output)
  useEffect(() => {
    const isContentSpan = isInputMessageSpan || isOutputSpan;
    // For input spans, we need messageIndex. For output spans, we use occurrence from span name.
    if (isRootSpan || !isContentSpan || !span || !rootSpan) {
      setMessageContent(null);
      return;
    }
    if (isInputMessageSpan && messageIndex === null) {
      setMessageContent(null);
      return;
    }

    // Get requestId from the span's own attributes (each span has its own request_id)
    // Get provider from root span (only stored there)
    const requestId = spanAttributes['ai.request_id'];
    const rootAttrs = parseAttributes(rootSpan.SpanAttributes);
    const provider = rootAttrs['ai.provider'] ?? rootAttrs['gen_ai.system'] ?? '';
    if (!requestId) {
      return;
    }

    const fetchMessageContent = async () => {
      setMessageContentLoading(true);
      try {
        const { id_token } = await getAccessTokenSilently({ detailedResponse: true });
        const apiUrl = import.meta.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8788';

        // For output spans, fetch response body; for input spans, fetch request body
        const bodyType = isOutputSpan ? 'response' : 'request';
        const res = await fetch(`${apiUrl}/bodies/${requestId}/${bodyType}`, {
          headers: { Authorization: `Bearer ${id_token}` },
        });

        if (!res.ok) {
          setMessageContent(null);
          return;
        }

        const text = await res.text();
        const body = formatBodyForDisplay(text);

        if (!body) {
          setMessageContent(null);
          return;
        }

        let extracted: { formatted: string; raw: object } | null = null;

        if (isOutputSpan) {
          // Extract content from response body
          extracted = extractOutputContent(body, contentType, span.SpanName);
        } else if (messageIndex !== null) {
          // Extract message from request body (provider-aware)
          if (body.format !== 'json') {
            setMessageContent(null);
            return;
          }
          extracted = extractMessageFromBody(body.content as object, messageIndex, provider);
        }

        setMessageContent(extracted);
      } catch {
        setMessageContent(null);
      } finally {
        setMessageContentLoading(false);
      }
    };

    void fetchMessageContent();
  }, [
    isRootSpan,
    isInputMessageSpan,
    isOutputSpan,
    span,
    rootSpan,
    messageIndex,
    contentType,
    getAccessTokenSilently,
  ]);

  const renderBodyContent = (formattedBody: FormattedBody | null, isResponse = false) => {
    if (!formattedBody) {
      return (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10 py-6 text-sm text-muted-foreground">
          No body available
        </div>
      );
    }

    switch (formattedBody.format) {
      case 'json':
        return (
          <pre className="max-h-[300px] overflow-auto rounded-lg border border-border/30 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300">
            {JSON.stringify(formattedBody.content, null, 2)}
          </pre>
        );

      case 'sse': {
        const events = formattedBody.content as ParsedSSEEvent[];

        if (isResponse && isMergedView) {
          const merged = mergeSSEEvents(events);
          return (
            <pre className="max-h-[300px] overflow-auto rounded-lg border border-border/30 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300">
              {JSON.stringify(merged, null, 2)}
            </pre>
          );
        }

        return (
          <div className="max-h-[300px] space-y-1 overflow-auto">
            {events.map((event, index) => (
              <div key={index} className="rounded-lg border border-border/30 bg-zinc-950 p-2">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-purple-400">
                    {event.event ?? 'message'}
                  </span>
                </div>
                <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-zinc-300">
                  {(() => {
                    try {
                      return JSON.stringify(JSON.parse(event.data), null, 2);
                    } catch {
                      return event.data;
                    }
                  })()}
                </pre>
              </div>
            ))}
          </div>
        );
      }

      default:
        return (
          <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/30 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300">
            {formattedBody.raw}
          </pre>
        );
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden p-0">
        <DialogHeader className="flex-shrink-0 border-b border-border/50 px-6 py-4">
          <div className="flex items-center justify-between pr-8">
            <div>
              <DialogTitle className="text-base font-medium text-foreground">
                {span?.SpanName ?? 'Span Details'}
              </DialogTitle>
              <DialogDescription className="mt-0.5 flex items-center gap-2 text-xs">
                {span && (
                  <>
                    <span className="tabular-nums">{formatDuration(span.Duration)}</span>
                    <span>·</span>
                    <span
                      className={span.StatusCode === 'ERROR' ? 'text-red-400' : 'text-emerald-400'}
                    >
                      {span.StatusCode}
                    </span>
                  </>
                )}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {span && (
            <>
              <div className="grid grid-cols-2 gap-2">
                {provider && (
                  <AttributeCard
                    icon={<Globe className="h-3.5 w-3.5" />}
                    label="Provider"
                    value={provider}
                  />
                )}
                {model && (
                  <AttributeCard
                    icon={<Server className="h-3.5 w-3.5" />}
                    label="Model"
                    value={model}
                    mono
                  />
                )}
                <AttributeCard
                  icon={<Clock className="h-3.5 w-3.5" />}
                  label="Timestamp"
                  value={formatTimestamp(span.Timestamp)}
                />
                <AttributeCard
                  icon={<Hash className="h-3.5 w-3.5" />}
                  label="Span ID"
                  value={span.SpanId}
                  mono
                />
                {span.ParentSpanId && span.ParentSpanId !== '' && (
                  <Link to={`/trace/${span.ParentSpanId}`}>
                    <AttributeCard
                      icon={<GitBranch className="h-3.5 w-3.5" />}
                      label="Parent Span"
                      value={span.ParentSpanId}
                      mono
                    />
                  </Link>
                )}
              </div>

              {(promptTokens > 0 ||
                completionTokens > 0 ||
                ttftMs !== null ||
                totalCost !== null) && (
                <div className="rounded-lg border border-border/40 bg-muted/10 p-3">
                  <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Token Breakdown
                  </h4>
                  <div className="grid grid-cols-4 gap-2">
                    {promptTokens > 0 && (
                      <div className="rounded-md bg-purple-500/10 p-2 text-center">
                        <Cpu className="mx-auto h-4 w-4 text-purple-400" />
                        <p className="mt-1 font-mono text-sm font-medium text-foreground">
                          {formatNumber(promptTokens)}
                        </p>
                        <p className="text-[10px] text-muted-foreground">Input</p>
                      </div>
                    )}
                    {completionTokens > 0 && (
                      <div className="rounded-md bg-blue-500/10 p-2 text-center">
                        <MessageSquare className="mx-auto h-4 w-4 text-blue-400" />
                        <p className="mt-1 font-mono text-sm font-medium text-foreground">
                          {formatNumber(completionTokens)}
                        </p>
                        <p className="text-[10px] text-muted-foreground">Output</p>
                      </div>
                    )}
                    {ttftMs !== null && (
                      <div className="rounded-md bg-amber-500/10 p-2 text-center">
                        <Zap className="mx-auto h-4 w-4 text-amber-400" />
                        <p className="mt-1 font-mono text-sm font-medium text-foreground">
                          {ttftMs.toFixed(0)}ms
                        </p>
                        <p className="text-[10px] text-muted-foreground">TTFT</p>
                      </div>
                    )}
                    {totalCost !== null && (
                      <div className="rounded-md bg-green-500/10 p-2 text-center">
                        <DollarSign className="mx-auto h-4 w-4 text-green-400" />
                        <p className="mt-1 font-mono text-sm font-medium text-foreground">
                          ${totalCost.toFixed(6)}
                        </p>
                        <p className="text-[10px] text-muted-foreground">Cost</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {((isInputMessageSpan && messageIndex !== null) || isOutputSpan) && !isRootSpan && (
                <Collapsible open={isMessageOpen} onOpenChange={setIsMessageOpen}>
                  <CollapsibleTrigger className="flex items-center gap-2 text-left transition-colors hover:opacity-70">
                    <ChevronDown
                      className={`h-4 w-4 text-muted-foreground transition-transform ${isMessageOpen ? 'rotate-0' : '-rotate-90'}`}
                    />
                    <span className="text-sm font-medium text-foreground">
                      {isOutputSpan ? 'Output Content' : 'Message Content'}
                    </span>
                    {messageIndex !== null && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        #{messageIndex}
                      </span>
                    )}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2">
                      {messageContentLoading ? (
                        <div className="flex items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10 py-6">
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                        </div>
                      ) : messageContent ? (
                        <div className="space-y-2">
                          <div className="flex gap-1">
                            <button
                              onClick={() => setMessageTab('formatted')}
                              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                                messageTab === 'formatted'
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                              }`}
                            >
                              Formatted
                            </button>
                            <button
                              onClick={() => setMessageTab('raw')}
                              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                                messageTab === 'raw'
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                              }`}
                            >
                              Raw JSON
                            </button>
                          </div>
                          {messageTab === 'formatted' ? (
                            <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/30 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300">
                              {messageContent.formatted}
                            </pre>
                          ) : (
                            <pre className="max-h-[300px] overflow-auto rounded-lg border border-border/30 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300">
                              {JSON.stringify(messageContent.raw, null, 2)}
                            </pre>
                          )}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border/50 bg-muted/10 p-4 text-center">
                          <p className="text-sm text-muted-foreground">Content not available</p>
                          <p className="mt-1 text-xs text-muted-foreground/70">
                            This may occur in multi-turn conversations where this message belongs to
                            a different request cycle.
                          </p>
                        </div>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}

              {isRootSpan && (
                <>
                  <Collapsible open={isResponseOpen} onOpenChange={setIsResponseOpen}>
                    <div className="flex items-center justify-between">
                      <CollapsibleTrigger className="flex items-center gap-2 text-left transition-colors hover:opacity-70">
                        <ChevronDown
                          className={`h-4 w-4 text-muted-foreground transition-transform ${isResponseOpen ? 'rotate-0' : '-rotate-90'}`}
                        />
                        <span className="text-sm font-medium text-foreground">Response</span>
                        {responseBody?.format === 'sse' && (
                          <span className="rounded-full bg-purple-500/15 px-2 py-0.5 text-[10px] font-medium text-purple-400">
                            SSE
                          </span>
                        )}
                      </CollapsibleTrigger>
                      {responseBody?.format === 'sse' && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Merge</span>
                          <Switch checked={isMergedView} onCheckedChange={setIsMergedView} />
                        </div>
                      )}
                    </div>
                    <CollapsibleContent>
                      <div className="mt-2">
                        {responseBodyLoading ? (
                          <div className="flex items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10 py-6">
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                          </div>
                        ) : (
                          renderBodyContent(responseBody, true)
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  <Collapsible open={isRequestOpen} onOpenChange={setIsRequestOpen}>
                    <CollapsibleTrigger className="flex items-center gap-2 text-left transition-colors hover:opacity-70">
                      <ChevronDown
                        className={`h-4 w-4 text-muted-foreground transition-transform ${isRequestOpen ? 'rotate-0' : '-rotate-90'}`}
                      />
                      <span className="text-sm font-medium text-foreground">Request</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-2">
                        {requestBodyLoading ? (
                          <div className="flex items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10 py-6">
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                          </div>
                        ) : (
                          renderBodyContent(requestBody)
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </>
              )}

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
                        const attrsJson = span['Events.Attributes'][index];
                        const attrs = attrsJson ? parseAttributes(attrsJson) : {};
                        const hasAttrs = Object.keys(attrs).length > 0;

                        return (
                          <div key={index} className="border-l-2 border-primary/50 py-1 pl-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-foreground">{name}</span>
                              {span['Events.Timestamp'][index] && (
                                <span className="text-[10px] text-muted-foreground">
                                  {formatTimestamp(span['Events.Timestamp'][index])}
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

              {remainingAttributes.length > 0 && (
                <Collapsible open={isAttributesOpen} onOpenChange={setIsAttributesOpen}>
                  <CollapsibleTrigger className="flex items-center gap-2 text-left transition-colors hover:opacity-70">
                    <ChevronDown
                      className={`h-4 w-4 text-muted-foreground transition-transform ${isAttributesOpen ? 'rotate-0' : '-rotate-90'}`}
                    />
                    <span className="text-sm font-medium text-foreground">More Attributes</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {remainingAttributes.length}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2 space-y-1 rounded-lg border border-border/30 bg-muted/10 p-2">
                      {remainingAttributes.map(([key, value]) => (
                        <div key={key} className="flex items-start gap-2 text-xs">
                          <span className="shrink-0 font-mono text-muted-foreground/70">{key}</span>
                          <span className="truncate text-foreground" title={value}>
                            {value}
                          </span>
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
