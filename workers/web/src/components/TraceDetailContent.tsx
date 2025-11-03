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

  // Reset body states when traceId changes
  useEffect(() => {
    setRequestBody(null);
    setResponseBody(null);
    setRequestBodyLoading(false);
    setResponseBodyLoading(false);
    setRequestBodyError(null);
    setResponseBodyError(null);
  }, [traceId]);

  // Fetch request body automatically when component is enabled
  useEffect(() => {
    if (enabled && traceId && !requestBody && !requestBodyLoading && requestBodyError === null) {
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
            // 404 means no body exists, which is fine
            if (res.status === 404) {
              setRequestBody(null);
              setRequestBodyLoading(false);
              return;
            }
            const errorData = await res.json();
            throw new Error(errorData.message ?? `HTTP ${res.status}: ${res.statusText}`);
          }

          const text = await res.text();
          setRequestBody(formatBodyForDisplay(text));
          setRequestBodyLoading(false);
        } catch (err) {
          setRequestBodyError(err instanceof Error ? err.message : 'Failed to fetch request body');
          setRequestBodyLoading(false);
        }
      };

      void fetchRequestBody();
    }
  }, [enabled, traceId, requestBody, requestBodyLoading, requestBodyError, getAccessTokenSilently]);

  // Fetch response body automatically when component is enabled
  useEffect(() => {
    if (enabled && traceId && !responseBody && !responseBodyLoading && responseBodyError === null) {
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
            // 404 means no body exists, which is fine
            if (res.status === 404) {
              setResponseBody(null);
              setResponseBodyLoading(false);
              return;
            }
            const errorData = await res.json();
            throw new Error(errorData.message ?? `HTTP ${res.status}: ${res.statusText}`);
          }

          const text = await res.text();
          setResponseBody(formatBodyForDisplay(text));
          setResponseBodyLoading(false);
        } catch (err) {
          setResponseBodyError(
            err instanceof Error ? err.message : 'Failed to fetch response body',
          );
          setResponseBodyLoading(false);
        }
      };

      void fetchResponseBody();
    }
  }, [
    enabled,
    traceId,
    responseBody,
    responseBodyLoading,
    responseBodyError,
    getAccessTokenSilently,
  ]);

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
      return <p className="text-sm text-gray-500 p-4 mt-2">No body available</p>;
    }

    switch (formattedBody.format) {
      case 'json':
        return (
          <div className="mt-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-block px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded">
                JSON
              </span>
            </div>
            <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 overflow-x-auto text-xs">
              {JSON.stringify(formattedBody.content, null, 2)}
            </pre>
          </div>
        );

      case 'sse': {
        const events = formattedBody.content as ParsedSSEEvent[];
        return (
          <div className="mt-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-block px-2 py-1 text-xs font-medium bg-purple-100 text-purple-800 rounded">
                Server-Sent Events ({events.length} events)
              </span>
            </div>
            <div className="space-y-2">
              {events.map((event, index) => (
                <div key={index} className="bg-gray-900 text-gray-100 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-medium text-purple-400">
                      {event.event ?? 'message'}
                    </span>
                    {event.id && <span className="text-xs text-gray-500">ID: {event.id}</span>}
                  </div>
                  <pre className="text-xs overflow-x-auto">
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
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-block px-2 py-1 text-xs font-medium bg-gray-100 text-gray-800 rounded">
                Plain Text
              </span>
            </div>
            <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 overflow-x-auto text-xs whitespace-pre-wrap break-words">
              {formattedBody.content as string}
            </pre>
          </div>
        );

      default:
        return (
          <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 mt-2 overflow-x-auto text-xs">
            {formattedBody.raw}
          </pre>
        );
    }
  };

  const renderSpanTree = (spans: TraceSpan[], parentId = '', depth = 0) => {
    const children = buildSpanTree(spans, parentId);

    return children.map((span) => (
      <div key={span.SpanId} style={{ marginLeft: `${depth * 20}px` }}>
        <div className="border-l-2 border-gray-300 pl-3 py-2">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900">{span.SpanName}</span>
                <span className="text-xs text-gray-500">{span.ServiceName}</span>
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs text-gray-600">
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
      <div className="flex justify-center items-center py-12">
        <div className="text-gray-600">Loading trace details...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h3 className="text-red-800 font-semibold mb-2">Error loading trace</h3>
        <p className="text-red-600 text-sm">{error.message}</p>
      </div>
    );
  }

  if (!rootSpan) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="text-gray-600">No trace data found</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Request Metadata</h3>
        <div className="bg-gray-50 rounded-lg p-4 space-y-2">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-sm text-gray-500">Timestamp</span>
              <p className="text-sm font-medium text-gray-900">
                {formatTimestamp(rootSpan.Timestamp)}
              </p>
            </div>
            <div>
              <span className="text-sm text-gray-500">Duration</span>
              <p className="text-sm font-medium text-gray-900">
                {formatDuration(rootSpan.Duration)}
              </p>
            </div>
            <div>
              <span className="text-sm text-gray-500">Status</span>
              <p className="text-sm font-medium text-gray-900">{rootSpan.StatusCode}</p>
            </div>
            <div>
              <span className="text-sm text-gray-500">Service</span>
              <p className="text-sm font-medium text-gray-900">{rootSpan.ServiceName}</p>
            </div>
          </div>
          <div>
            <span className="text-sm text-gray-500">Trace ID</span>
            <p className="text-xs font-mono text-gray-900 break-all">{rootSpan.TraceId}</p>
          </div>
          {rootSpan.StatusMessage && (
            <div>
              <span className="text-sm text-gray-500">Status Message</span>
              <p className="text-sm text-gray-900">{rootSpan.StatusMessage}</p>
            </div>
          )}
        </div>
      </section>

      <section>
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Request Body</h3>
        <Collapsible open={isRequestOpen} onOpenChange={setIsRequestOpen}>
          <CollapsibleTrigger className="flex items-center gap-2 w-full bg-gray-50 hover:bg-gray-100 rounded-lg p-3 text-left transition-colors">
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
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mt-2">
                <p className="text-red-600 text-sm">{requestBodyError}</p>
              </div>
            ) : requestBodyLoading ? (
              <div className="text-sm text-gray-500 p-4 mt-2">Loading request body...</div>
            ) : (
              renderBodyContent(requestBody)
            )}
          </CollapsibleContent>
        </Collapsible>
      </section>

      <section>
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Response Body</h3>
        <Collapsible open={isResponseOpen} onOpenChange={setIsResponseOpen}>
          <CollapsibleTrigger className="flex items-center gap-2 w-full bg-gray-50 hover:bg-gray-100 rounded-lg p-3 text-left transition-colors">
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
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mt-2">
                <p className="text-red-600 text-sm">{responseBodyError}</p>
              </div>
            ) : responseBodyLoading ? (
              <div className="text-sm text-gray-500 p-4 mt-2">Loading response body...</div>
            ) : (
              renderBodyContent(responseBody)
            )}
          </CollapsibleContent>
        </Collapsible>
      </section>

      <section>
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Span Attributes</h3>
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="space-y-1">
            {Object.entries(parseAttributes(rootSpan.SpanAttributes)).map(([key, value]) => (
              <div key={key} className="flex items-start gap-2">
                <span className="text-sm font-mono text-gray-600 min-w-[200px]">{key}:</span>
                <span className="text-sm text-gray-900 break-all">{value}</span>
              </div>
            ))}
            {Object.keys(parseAttributes(rootSpan.SpanAttributes)).length === 0 && (
              <p className="text-sm text-gray-500">No span attributes</p>
            )}
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Resource Attributes</h3>
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="space-y-1">
            {Object.entries(parseAttributes(rootSpan.ResourceAttributes)).map(([key, value]) => (
              <div key={key} className="flex items-start gap-2">
                <span className="text-sm font-mono text-gray-600 min-w-[200px]">{key}:</span>
                <span className="text-sm text-gray-900 break-all">{value}</span>
              </div>
            ))}
            {Object.keys(parseAttributes(rootSpan.ResourceAttributes)).length === 0 && (
              <p className="text-sm text-gray-500">No resource attributes</p>
            )}
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-lg font-semibold text-gray-900 mb-3">
          Child Spans ({spans.length - 1})
        </h3>
        <div className="bg-gray-50 rounded-lg p-4">
          {spans.length > 1 ? (
            renderSpanTree(spans, rootSpan.SpanId, 0)
          ) : (
            <p className="text-sm text-gray-500">No child spans</p>
          )}
        </div>
      </section>

      {rootSpan['Events.Name'] && rootSpan['Events.Name'].length > 0 && (
        <section>
          <h3 className="text-lg font-semibold text-gray-900 mb-3">Events</h3>
          <div className="bg-gray-50 rounded-lg p-4 space-y-3">
            {rootSpan['Events.Name'].map((name, index) => (
              <div key={index} className="border-l-2 border-blue-400 pl-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <span className="font-medium text-gray-900">{name}</span>
                    {rootSpan['Events.Timestamp'][index] && (
                      <p className="text-xs text-gray-600 mt-1">
                        {formatTimestamp(rootSpan['Events.Timestamp'][index])}
                      </p>
                    )}
                    {rootSpan['Events.Attributes'][index] && (
                      <pre className="text-xs text-gray-600 mt-2 overflow-x-auto">
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
