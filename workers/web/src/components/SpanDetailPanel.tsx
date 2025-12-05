import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import { Clock, Hash, Globe, Server, Cpu, MessageSquare, Zap, GitBranch } from 'lucide-react';
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

export function SpanDetailPanel({ span, isRootSpan, isOpen, onClose }: SpanDetailPanelProps) {
  const { getAccessTokenSilently } = useAuth0();
  const [requestBody, setRequestBody] = useState<FormattedBody | null>(null);
  const [responseBody, setResponseBody] = useState<FormattedBody | null>(null);
  const [requestBodyLoading, setRequestBodyLoading] = useState(false);
  const [responseBodyLoading, setResponseBodyLoading] = useState(false);
  const [isRequestOpen, setIsRequestOpen] = useState(true);
  const [isResponseOpen, setIsResponseOpen] = useState(true);
  const [isEventsOpen, setIsEventsOpen] = useState(false);
  const [isAttributesOpen, setIsAttributesOpen] = useState(false);
  const [isMergedView, setIsMergedView] = useState(true);

  const spanAttributes = span ? parseAttributes(span.SpanAttributes) : {};
  const resourceAttributes = span ? parseAttributes(span.ResourceAttributes) : {};
  const allAttributes = { ...spanAttributes, ...resourceAttributes };

  const provider = allAttributes['llm.provider'] ?? allAttributes['gen_ai.system'] ?? '';
  const model = allAttributes['llm.model'] ?? allAttributes['gen_ai.request.model'] ?? '';
  const promptTokens =
    parseInt(allAttributes['llm.tokens.prompt'] ?? '0', 10) ||
    parseInt(allAttributes['llm.tokens.input'] ?? '0', 10) ||
    parseInt(allAttributes['gen_ai.usage.input_tokens'] ?? '0', 10);
  const completionTokens =
    parseInt(allAttributes['llm.tokens.completion'] ?? '0', 10) ||
    parseInt(allAttributes['llm.tokens.output'] ?? '0', 10) ||
    parseInt(allAttributes['gen_ai.usage.output_tokens'] ?? '0', 10);
  const ttftMs = allAttributes['llm.time_to_first_token_ms']
    ? parseFloat(allAttributes['llm.time_to_first_token_ms'])
    : null;

  const displayedKeys = new Set([
    'llm.provider',
    'gen_ai.system',
    'llm.model',
    'gen_ai.request.model',
    'llm.tokens.prompt',
    'llm.tokens.input',
    'llm.tokens.completion',
    'llm.tokens.output',
    'llm.tokens.total',
    'llm.time_to_first_token_ms',
    'gen_ai.usage.input_tokens',
    'gen_ai.usage.output_tokens',
    'service.name',
  ]);
  const remainingAttributes = Object.entries(allAttributes).filter(
    ([key]) => !displayedKeys.has(key),
  );

  useEffect(() => {
    if (!isRootSpan || !span) return;

    // Extract requestId from span attributes - bodies are stored by requestId not traceId
    const attrs = parseAttributes(span.SpanAttributes);
    const requestId = attrs['llm.request_id'];
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

              {(promptTokens > 0 || completionTokens > 0 || ttftMs !== null) && (
                <div className="rounded-lg border border-border/40 bg-muted/10 p-3">
                  <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Token Breakdown
                  </h4>
                  <div className="grid grid-cols-3 gap-2">
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
                  </div>
                </div>
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
                      {span['Events.Name'].map((name, index) => (
                        <div key={index} className="border-l-2 border-primary/50 py-1 pl-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-foreground">{name}</span>
                            {span['Events.Timestamp'][index] && (
                              <span className="text-[10px] text-muted-foreground">
                                {formatTimestamp(span['Events.Timestamp'][index])}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
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
