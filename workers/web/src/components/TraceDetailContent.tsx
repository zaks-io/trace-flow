'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import { ChevronDown, Globe, Clock, Hash, Server, Link2, FileJson, GitBranch } from 'lucide-react';
import {
  formatBodyForDisplay,
  mergeSSEEvents,
  type FormattedBody,
  type ParsedSSEEvent,
} from '@trace-flow/utils';

export interface TraceSpan {
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

interface TraceDetailContentProps {
  traceId: string;
  enabled?: boolean;
  spans?: TraceSpan[];
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

export function TraceDetailContent({
  traceId,
  enabled = true,
  spans = [],
}: TraceDetailContentProps) {
  const [requestBody, setRequestBody] = useState<FormattedBody | null>(null);
  const [responseBody, setResponseBody] = useState<FormattedBody | null>(null);
  const [requestBodyLoading, setRequestBodyLoading] = useState(false);
  const [responseBodyLoading, setResponseBodyLoading] = useState(false);
  const [requestBodyError, setRequestBodyError] = useState<string | null>(null);
  const [responseBodyError, setResponseBodyError] = useState<string | null>(null);
  const [requestBodyFetched, setRequestBodyFetched] = useState(false);
  const [responseBodyFetched, setResponseBodyFetched] = useState(false);
  const [isRequestOpen, setIsRequestOpen] = useState(true);
  const [isResponseOpen, setIsResponseOpen] = useState(true);
  const [isChildSpansOpen, setIsChildSpansOpen] = useState(false);
  const [isEventsOpen, setIsEventsOpen] = useState(false);
  const [isMoreAttributesOpen, setIsMoreAttributesOpen] = useState(false);
  const [isMergedView, setIsMergedView] = useState(true);

  // Find root span by trace_flow.source attribute
  const rootSpan = spans.find((s) => {
    try {
      const attrs =
        typeof s.SpanAttributes === 'string'
          ? (JSON.parse(s.SpanAttributes) as Record<string, string>)
          : (s.SpanAttributes as unknown as Record<string, string>);
      return attrs['trace_flow.source'] === 'proxy';
    } catch {
      return false;
    }
  });

  // Extract requestId from root span attributes - bodies are stored by requestId not traceId
  const rootSpanAttributes = (() => {
    if (!rootSpan?.SpanAttributes) return {};
    try {
      return typeof rootSpan.SpanAttributes === 'string'
        ? (JSON.parse(rootSpan.SpanAttributes) as Record<string, string>)
        : (rootSpan.SpanAttributes as unknown as Record<string, string>);
    } catch {
      return {};
    }
  })();
  const requestId = rootSpanAttributes['gen_ai.request_id'];

  useEffect(() => {
    setRequestBody(null);
    setResponseBody(null);
    setRequestBodyLoading(false);
    setResponseBodyLoading(false);
    setRequestBodyError(null);
    setResponseBodyError(null);
    setRequestBodyFetched(false);
    setResponseBodyFetched(false);
  }, [traceId]);

  useEffect(() => {
    // Bodies are stored by requestId, not traceId
    if (!requestId) return;

    if (enabled && !requestBodyFetched && !requestBodyLoading) {
      setRequestBodyLoading(true);
      setRequestBodyError(null);

      const fetchRequestBody = async () => {
        try {
          // Get ID token from our API endpoint
          const tokenRes = await fetch('/api/token');
          if (!tokenRes.ok) {
            window.location.href = `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
            return;
          }
          const { token: id_token } = await tokenRes.json();
          const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8788';

          const res = await fetch(`${apiUrl}/bodies/${requestId}/request`, {
            headers: {
              Authorization: `Bearer ${id_token}`,
            },
          });

          if (!res.ok) {
            if (res.status === 404) {
              setRequestBody(null);
              setRequestBodyLoading(false);
              setRequestBodyFetched(true);
              return;
            }
            const errorData = await res.json();
            throw new Error(errorData.message ?? `HTTP ${res.status}: ${res.statusText}`);
          }

          const text = await res.text();
          setRequestBody(formatBodyForDisplay(text));
          setRequestBodyLoading(false);
          setRequestBodyFetched(true);
        } catch (err) {
          setRequestBodyError(err instanceof Error ? err.message : 'Failed to fetch request body');
          setRequestBodyLoading(false);
          setRequestBodyFetched(true);
        }
      };

      void fetchRequestBody();
    }
  }, [enabled, requestId, requestBodyFetched, requestBodyLoading]);

  useEffect(() => {
    // Bodies are stored by requestId, not traceId
    if (!requestId) return;

    if (enabled && !responseBodyFetched && !responseBodyLoading) {
      setResponseBodyLoading(true);
      setResponseBodyError(null);

      const fetchResponseBody = async () => {
        try {
          // Get ID token from our API endpoint
          const tokenRes = await fetch('/api/token');
          if (!tokenRes.ok) {
            window.location.href = `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
            return;
          }
          const { token: id_token } = await tokenRes.json();
          const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8788';

          const res = await fetch(`${apiUrl}/bodies/${requestId}/response`, {
            headers: {
              Authorization: `Bearer ${id_token}`,
            },
          });

          if (!res.ok) {
            if (res.status === 404) {
              setResponseBody(null);
              setResponseBodyLoading(false);
              setResponseBodyFetched(true);
              return;
            }
            const errorData = await res.json();
            throw new Error(errorData.message ?? `HTTP ${res.status}: ${res.statusText}`);
          }

          const text = await res.text();
          setResponseBody(formatBodyForDisplay(text));
          setResponseBodyLoading(false);
          setResponseBodyFetched(true);
        } catch (err) {
          setResponseBodyError(
            err instanceof Error ? err.message : 'Failed to fetch response body',
          );
          setResponseBodyLoading(false);
          setResponseBodyFetched(true);
        }
      };

      void fetchResponseBody();
    }
  }, [enabled, requestId, responseBodyFetched, responseBodyLoading]);

  const formatTimestamp = (nanoseconds: number) => {
    const milliseconds = nanoseconds / 1_000_000;
    return new Date(milliseconds).toLocaleString();
  };

  const formatDuration = (nanoseconds: number) => {
    const milliseconds = nanoseconds / 1_000_000;
    return `${milliseconds.toFixed(2)}ms`;
  };

  const parseAttributes = (attributesJson: string): Record<string, string> => {
    try {
      return typeof attributesJson === 'string'
        ? (JSON.parse(attributesJson) as Record<string, string>)
        : (attributesJson as unknown as Record<string, string>);
    } catch {
      return {};
    }
  };

  const buildSpanTree = (spans: TraceSpan[], parentId = ''): TraceSpan[] => {
    return spans
      .filter((span) => span.ParentSpanId === parentId)
      .sort((a, b) => a.Timestamp - b.Timestamp);
  };

  const renderBodyContent = (formattedBody: FormattedBody | null, isResponse = false) => {
    if (!formattedBody) {
      return (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10 py-8 text-sm text-muted-foreground">
          No body available
        </div>
      );
    }

    switch (formattedBody.format) {
      case 'json':
        return (
          <pre className="max-h-[400px] overflow-auto rounded-lg border border-border/30 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300">
            {JSON.stringify(formattedBody.content, null, 2)}
          </pre>
        );

      case 'sse': {
        const events = formattedBody.content as ParsedSSEEvent[];

        if (isResponse && isMergedView) {
          const merged = mergeSSEEvents(events);
          return (
            <pre className="max-h-[400px] overflow-auto rounded-lg border border-border/30 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300">
              {JSON.stringify(merged, null, 2)}
            </pre>
          );
        }

        return (
          <div className="max-h-[400px] space-y-1 overflow-auto">
            {events.map((event, index) => (
              <div key={index} className="rounded-lg border border-border/30 bg-zinc-950 p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-purple-400">
                    {event.event ?? 'message'}
                  </span>
                  {event.id && (
                    <span className="text-[10px] text-muted-foreground">#{event.id}</span>
                  )}
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

      case 'text':
        return (
          <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/30 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300">
            {formattedBody.content as string}
          </pre>
        );

      default:
        return (
          <pre className="max-h-[400px] overflow-auto rounded-lg border border-border/30 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300">
            {formattedBody.raw}
          </pre>
        );
    }
  };

  const renderSpanTree = (spans: TraceSpan[], parentId = '', depth = 0) => {
    const children = buildSpanTree(spans, parentId);

    return children.map((span) => (
      <div key={span.SpanId} style={{ marginLeft: `${depth * 16}px` }}>
        <div className="border-l border-border/50 py-1.5 pl-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-foreground">{span.SpanName}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {formatDuration(span.Duration)}
            </span>
            <span
              className={`text-xs ${span.StatusCode === 'ERROR' ? 'text-red-400' : 'text-muted-foreground'}`}
            >
              {span.StatusCode}
            </span>
          </div>
        </div>
        {renderSpanTree(spans, span.SpanId, depth + 1)}
      </div>
    ));
  };

  const spanAttributes = rootSpan ? parseAttributes(rootSpan.SpanAttributes) : {};
  const resourceAttributes = rootSpan ? parseAttributes(rootSpan.ResourceAttributes) : {};
  const allAttributes = { ...spanAttributes, ...resourceAttributes };

  // Extract key attributes for the card display
  const provider = allAttributes['gen_ai.system'] ?? '';
  const model = allAttributes['gen_ai.request.model'] ?? '';
  const targetUrl = allAttributes['http.url'] ?? '';
  const statusCode = allAttributes['http.response.status_code'] ?? '';
  const responseId = allAttributes['gen_ai.response.id'] ?? '';

  // Get remaining attributes (not shown in cards)
  const displayedKeys = new Set([
    'gen_ai.system',
    'gen_ai.request.model',
    'http.url',
    'http.response.status_code',
    'gen_ai.response.id',
    'service.name',
  ]);
  const remainingAttributes = Object.entries(allAttributes).filter(
    ([key]) => !displayedKeys.has(key),
  );

  return (
    <div className="space-y-5">
      {/* Key Attributes Grid */}
      {rootSpan && (
        <div className="space-y-3">
          {/* Primary row - most important info */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
            {statusCode && (
              <AttributeCard
                icon={<Hash className="h-3.5 w-3.5" />}
                label="Status"
                value={statusCode}
                mono
              />
            )}
            <AttributeCard
              icon={<Clock className="h-3.5 w-3.5" />}
              label="Timestamp"
              value={formatTimestamp(rootSpan.Timestamp)}
            />
          </div>

          {/* Secondary row */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {targetUrl && (
              <AttributeCard
                icon={<Link2 className="h-3.5 w-3.5" />}
                label="Endpoint"
                value={targetUrl}
                mono
              />
            )}
            {responseId && (
              <AttributeCard
                icon={<FileJson className="h-3.5 w-3.5" />}
                label="Response ID"
                value={responseId}
                mono
              />
            )}
          </div>

          {/* Parent Span row */}
          {rootSpan.ParentSpanId && rootSpan.ParentSpanId !== '' && (
            <div className="grid grid-cols-1 gap-2">
              <Link href={`/app/trace/${rootSpan.ParentSpanId}`}>
                <AttributeCard
                  icon={<GitBranch className="h-3.5 w-3.5" />}
                  label="Parent Span"
                  value={rootSpan.ParentSpanId}
                  mono
                />
              </Link>
            </div>
          )}

          {/* More attributes - collapsed */}
          {remainingAttributes.length > 0 && (
            <Collapsible open={isMoreAttributesOpen} onOpenChange={setIsMoreAttributesOpen}>
              <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${isMoreAttributesOpen ? 'rotate-0' : '-rotate-90'}`}
                />
                <span>{remainingAttributes.length} more attributes</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 grid grid-cols-1 gap-1.5 rounded-lg border border-border/30 bg-muted/10 p-3 sm:grid-cols-2">
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
        </div>
      )}

      {/* Divider */}
      <div className="border-t border-border/30" />

      {/* Response Body - Collapsible */}
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
          <div className="mt-3">
            {responseBodyError ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                <p className="text-sm text-red-400">{responseBodyError}</p>
              </div>
            ) : responseBodyLoading ? (
              <div className="flex items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10 py-8">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              </div>
            ) : (
              renderBodyContent(responseBody, true)
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Request Body - Collapsible */}
      <Collapsible open={isRequestOpen} onOpenChange={setIsRequestOpen}>
        <CollapsibleTrigger className="flex items-center gap-2 text-left transition-colors hover:opacity-70">
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${isRequestOpen ? 'rotate-0' : '-rotate-90'}`}
          />
          <span className="text-sm font-medium text-foreground">Request</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3">
            {requestBodyError ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                <p className="text-sm text-red-400">{requestBodyError}</p>
              </div>
            ) : requestBodyLoading ? (
              <div className="flex items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10 py-8">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              </div>
            ) : (
              renderBodyContent(requestBody)
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Child Spans - Collapsed */}
      {spans.length > 1 && rootSpan && (
        <Collapsible open={isChildSpansOpen} onOpenChange={setIsChildSpansOpen}>
          <CollapsibleTrigger className="flex items-center gap-2 text-left transition-colors hover:opacity-70">
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform ${isChildSpansOpen ? 'rotate-0' : '-rotate-90'}`}
            />
            <span className="text-sm font-medium text-foreground">Child Spans</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {spans.length - 1}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 rounded-lg border border-border/30 bg-muted/10 p-3">
              {renderSpanTree(spans, rootSpan.SpanId, 0)}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Events - Collapsed */}
      {rootSpan?.['Events.Name'] && rootSpan['Events.Name'].length > 0 && (
        <Collapsible open={isEventsOpen} onOpenChange={setIsEventsOpen}>
          <CollapsibleTrigger className="flex items-center gap-2 text-left transition-colors hover:opacity-70">
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform ${isEventsOpen ? 'rotate-0' : '-rotate-90'}`}
            />
            <span className="text-sm font-medium text-foreground">Events</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {rootSpan['Events.Name'].length}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 space-y-2 rounded-lg border border-border/30 bg-muted/10 p-3">
              {rootSpan['Events.Name'].map((name, index) => (
                <div key={index} className="border-l-2 border-primary/50 pl-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{name}</span>
                    {rootSpan['Events.Timestamp'][index] && (
                      <span className="text-xs text-muted-foreground">
                        {formatTimestamp(rootSpan['Events.Timestamp'][index])}
                      </span>
                    )}
                  </div>
                  {rootSpan['Events.Attributes'][index] && (
                    <pre className="mt-1 overflow-x-auto font-mono text-xs text-muted-foreground">
                      {JSON.stringify(
                        parseAttributes(rootSpan['Events.Attributes'][index]),
                        null,
                        2,
                      )}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
