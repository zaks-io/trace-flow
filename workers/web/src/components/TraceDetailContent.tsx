'use client';

import { useState, useEffect } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import { formatBodyForDisplay, type FormattedBody, type ParsedSSEEvent } from '@observe/utils';

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

interface TinybirdResponse {
  data: TraceSpan[];
}

interface TraceDetailContentProps {
  traceId: string;
  enabled?: boolean;
}

export function TraceDetailContent({ traceId, enabled = true }: TraceDetailContentProps) {
  const { getAccessTokenSilently } = useAuth0();
  const [requestBody, setRequestBody] = useState<FormattedBody | null>(null);
  const [responseBody, setResponseBody] = useState<FormattedBody | null>(null);
  const [requestBodyLoading, setRequestBodyLoading] = useState(false);
  const [responseBodyLoading, setResponseBodyLoading] = useState(false);
  const [requestBodyError, setRequestBodyError] = useState<string | null>(null);
  const [responseBodyError, setResponseBodyError] = useState<string | null>(null);
  const [requestBodyFetched, setRequestBodyFetched] = useState(false);
  const [responseBodyFetched, setResponseBodyFetched] = useState(false);
  const [isRequestOpen, setIsRequestOpen] = useState(false);
  const [isResponseOpen, setIsResponseOpen] = useState(true);

  const { data, loading, error } = useTinybirdQuery<TinybirdResponse>({
    sql: `SELECT
      Timestamp, TraceId, SpanId, ParentSpanId, SpanName, ServiceName,
      Duration, StatusCode, StatusMessage, SpanAttributes, ResourceAttributes,
      Events.Timestamp, Events.Name, Events.Attributes
    FROM otel_traces
    WHERE TraceId = '${traceId}'
    ORDER BY Timestamp ASC
    FORMAT JSON`,
    scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
    enabled: enabled && !!traceId,
  });

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
    if (enabled && traceId && !requestBodyFetched && !requestBodyLoading) {
      setRequestBodyLoading(true);
      setRequestBodyError(null);

      const fetchRequestBody = async () => {
        try {
          const { id_token } = await getAccessTokenSilently({ detailedResponse: true });
          const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8788';

          const res = await fetch(`${apiUrl}/bodies/${traceId}/request`, {
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
  }, [enabled, traceId, requestBodyFetched, requestBodyLoading, getAccessTokenSilently]);

  useEffect(() => {
    if (enabled && traceId && !responseBodyFetched && !responseBodyLoading) {
      setResponseBodyLoading(true);
      setResponseBodyError(null);

      const fetchResponseBody = async () => {
        try {
          const { id_token } = await getAccessTokenSilently({ detailedResponse: true });
          const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8788';

          const res = await fetch(`${apiUrl}/bodies/${traceId}/response`, {
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
  }, [enabled, traceId, responseBodyFetched, responseBodyLoading, getAccessTokenSilently]);

  const spans = data?.data ?? [];
  const rootSpan = spans.find((s) => s.ParentSpanId === '');

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
      return JSON.parse(attributesJson) as Record<string, string>;
    } catch {
      return {};
    }
  };

  const buildSpanTree = (spans: TraceSpan[], parentId = ''): TraceSpan[] => {
    return spans
      .filter((span) => span.ParentSpanId === parentId)
      .sort((a, b) => a.Timestamp - b.Timestamp);
  };

  const renderBodyContent = (formattedBody: FormattedBody | null) => {
    if (!formattedBody) {
      return <p className="mt-2 p-4 text-sm text-muted-foreground">No body available</p>;
    }

    switch (formattedBody.format) {
      case 'json':
        return (
          <div className="mt-2">
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-block rounded bg-blue-500/20 px-2 py-1 text-xs font-medium text-blue-400">
                JSON
              </span>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-background p-4 text-xs text-foreground">
              {JSON.stringify(formattedBody.content, null, 2)}
            </pre>
          </div>
        );

      case 'sse': {
        const events = formattedBody.content as ParsedSSEEvent[];
        return (
          <div className="mt-2">
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-block rounded bg-purple-500/20 px-2 py-1 text-xs font-medium text-purple-400">
                Server-Sent Events ({events.length} events)
              </span>
            </div>
            <div className="space-y-2">
              {events.map((event, index) => (
                <div key={index} className="rounded-lg bg-background p-4 text-foreground">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-xs font-medium text-purple-400">
                      {event.event ?? 'message'}
                    </span>
                    {event.id && (
                      <span className="text-xs text-muted-foreground">ID: {event.id}</span>
                    )}
                  </div>
                  <pre className="overflow-x-auto text-xs">
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
          </div>
        );
      }

      case 'text':
        return (
          <div className="mt-2">
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-block rounded bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                Plain Text
              </span>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-background p-4 text-xs text-foreground">
              {formattedBody.content as string}
            </pre>
          </div>
        );

      default:
        return (
          <pre className="mt-2 overflow-x-auto rounded-lg bg-background p-4 text-xs text-foreground">
            {formattedBody.raw}
          </pre>
        );
    }
  };

  const renderSpanTree = (spans: TraceSpan[], parentId = '', depth = 0) => {
    const children = buildSpanTree(spans, parentId);

    return children.map((span) => (
      <div key={span.SpanId} style={{ marginLeft: `${depth * 20}px` }}>
        <div className="border-l-2 border-border py-2 pl-3">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground">{span.SpanName}</span>
                <span className="text-xs text-muted-foreground">{span.ServiceName}</span>
              </div>
              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span>Duration: {formatDuration(span.Duration)}</span>
                <span>Status: {span.StatusCode}</span>
              </div>
            </div>
          </div>
        </div>
        {renderSpanTree(spans, span.SpanId, depth + 1)}
      </div>
    ));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground">Loading trace details...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
        <h3 className="mb-2 font-semibold text-destructive">Error loading trace</h3>
        <p className="text-sm text-destructive/80">{error.message}</p>
      </div>
    );
  }

  if (!rootSpan) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground">No trace data found</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-lg font-semibold text-foreground">Request Metadata</h3>
        <div className="space-y-2 rounded-lg bg-muted/50 p-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-sm text-muted-foreground">Timestamp</span>
              <p className="text-sm font-medium text-foreground">
                {formatTimestamp(rootSpan.Timestamp)}
              </p>
            </div>
            <div>
              <span className="text-sm text-muted-foreground">Duration</span>
              <p className="text-sm font-medium text-foreground">
                {formatDuration(rootSpan.Duration)}
              </p>
            </div>
            <div>
              <span className="text-sm text-muted-foreground">Status</span>
              <p className="text-sm font-medium text-foreground">{rootSpan.StatusCode}</p>
            </div>
            <div>
              <span className="text-sm text-muted-foreground">Service</span>
              <p className="text-sm font-medium text-foreground">{rootSpan.ServiceName}</p>
            </div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Trace ID</span>
            <p className="break-all font-mono text-xs text-foreground">{rootSpan.TraceId}</p>
          </div>
          {rootSpan.StatusMessage && (
            <div>
              <span className="text-sm text-muted-foreground">Status Message</span>
              <p className="text-sm text-foreground">{rootSpan.StatusMessage}</p>
            </div>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-lg font-semibold text-foreground">Request Body</h3>
        <Collapsible open={isRequestOpen} onOpenChange={setIsRequestOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg bg-muted/50 p-3 text-left transition-colors hover:bg-muted">
            <ChevronDown
              className={`h-4 w-4 transition-transform ${isRequestOpen ? 'rotate-0' : '-rotate-90'}`}
            />
            <span className="text-sm font-medium">
              {requestBodyLoading
                ? 'Loading...'
                : requestBody
                  ? 'Request Body'
                  : requestBodyError
                    ? 'Error loading request body'
                    : 'No request body'}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {requestBodyError ? (
              <div className="mt-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
                <p className="text-sm text-destructive">{requestBodyError}</p>
              </div>
            ) : requestBodyLoading ? (
              <div className="mt-2 p-4 text-sm text-muted-foreground">Loading request body...</div>
            ) : (
              renderBodyContent(requestBody)
            )}
          </CollapsibleContent>
        </Collapsible>
      </section>

      <section>
        <h3 className="mb-3 text-lg font-semibold text-foreground">Response Body</h3>
        <Collapsible open={isResponseOpen} onOpenChange={setIsResponseOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg bg-muted/50 p-3 text-left transition-colors hover:bg-muted">
            <ChevronDown
              className={`h-4 w-4 transition-transform ${isResponseOpen ? 'rotate-0' : '-rotate-90'}`}
            />
            <span className="text-sm font-medium">
              {responseBodyLoading
                ? 'Loading...'
                : responseBody
                  ? 'Response Body'
                  : responseBodyError
                    ? 'Error loading response body'
                    : 'No response body'}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {responseBodyError ? (
              <div className="mt-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
                <p className="text-sm text-destructive">{responseBodyError}</p>
              </div>
            ) : responseBodyLoading ? (
              <div className="mt-2 p-4 text-sm text-muted-foreground">Loading response body...</div>
            ) : (
              renderBodyContent(responseBody)
            )}
          </CollapsibleContent>
        </Collapsible>
      </section>

      <section>
        <h3 className="mb-3 text-lg font-semibold text-foreground">Span Attributes</h3>
        <div className="rounded-lg bg-muted/50 p-4">
          <div className="space-y-1">
            {Object.entries(parseAttributes(rootSpan.SpanAttributes)).map(([key, value]) => (
              <div key={key} className="flex items-start gap-2">
                <span className="min-w-[200px] font-mono text-sm text-muted-foreground">
                  {key}:
                </span>
                <span className="break-all text-sm text-foreground">{value}</span>
              </div>
            ))}
            {Object.keys(parseAttributes(rootSpan.SpanAttributes)).length === 0 && (
              <p className="text-sm text-muted-foreground">No span attributes</p>
            )}
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-lg font-semibold text-foreground">Resource Attributes</h3>
        <div className="rounded-lg bg-muted/50 p-4">
          <div className="space-y-1">
            {Object.entries(parseAttributes(rootSpan.ResourceAttributes)).map(([key, value]) => (
              <div key={key} className="flex items-start gap-2">
                <span className="min-w-[200px] font-mono text-sm text-muted-foreground">
                  {key}:
                </span>
                <span className="break-all text-sm text-foreground">{value}</span>
              </div>
            ))}
            {Object.keys(parseAttributes(rootSpan.ResourceAttributes)).length === 0 && (
              <p className="text-sm text-muted-foreground">No resource attributes</p>
            )}
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-lg font-semibold text-foreground">
          Child Spans ({spans.length - 1})
        </h3>
        <div className="rounded-lg bg-muted/50 p-4">
          {spans.length > 1 ? (
            renderSpanTree(spans, rootSpan.SpanId, 0)
          ) : (
            <p className="text-sm text-muted-foreground">No child spans</p>
          )}
        </div>
      </section>

      {rootSpan['Events.Name'] && rootSpan['Events.Name'].length > 0 && (
        <section>
          <h3 className="mb-3 text-lg font-semibold text-foreground">Events</h3>
          <div className="space-y-3 rounded-lg bg-muted/50 p-4">
            {rootSpan['Events.Name'].map((name, index) => (
              <div key={index} className="border-l-2 border-primary pl-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <span className="font-medium text-foreground">{name}</span>
                    {rootSpan['Events.Timestamp'][index] && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatTimestamp(rootSpan['Events.Timestamp'][index])}
                      </p>
                    )}
                    {rootSpan['Events.Attributes'][index] && (
                      <pre className="mt-2 overflow-x-auto text-xs text-muted-foreground">
                        {JSON.stringify(
                          parseAttributes(rootSpan['Events.Attributes'][index]),
                          null,
                          2,
                        )}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
