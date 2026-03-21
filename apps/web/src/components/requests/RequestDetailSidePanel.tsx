'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { parseSpanAttributes } from '@trace-flow/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  ChevronDown,
  Globe,
  Clock,
  Hash,
  Server,
  Link2,
  FileJson,
  ExternalLink,
} from 'lucide-react';
import { mergeSSEEvents, type FormattedBody, type ParsedSSEEvent } from '@trace-flow/utils';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { AlertBadge, AlertList } from '@/components/alerts';
import { fetchStoredBodies, formatStoredBodiesForDisplay } from '@/lib/bodies';
import { evaluateAlertsForTraces, getHighestSeverity } from '@/lib/alerts';
import { formatModelDisplay } from '@/lib/format';
import type { AlertSeverity } from '@/types/alerts';
import type { RequestRow } from '@/components/requests/data-table';

interface RequestDetailSidePanelProps {
  request: RequestRow | null;
  isOpen: boolean;
  onClose: () => void;
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

function BodySkeleton() {
  return (
    <div className="space-y-2 rounded-lg border border-border/30 bg-zinc-950 p-4">
      <Skeleton className="h-3 w-3/4 bg-zinc-800" />
      <Skeleton className="h-3 w-1/2 bg-zinc-800" />
      <Skeleton className="h-3 w-5/6 bg-zinc-800" />
      <Skeleton className="h-3 w-2/3 bg-zinc-800" />
    </div>
  );
}

export function RequestDetailSidePanel({ request, isOpen, onClose }: RequestDetailSidePanelProps) {
  const [requestBody, setRequestBody] = useState<FormattedBody | null>(null);
  const [responseBody, setResponseBody] = useState<FormattedBody | null>(null);
  const [bodiesLoading, setBodiesLoading] = useState(false);
  const [bodiesError, setBodiesError] = useState<string | null>(null);
  const [isRequestOpen, setIsRequestOpen] = useState(true);
  const [isResponseOpen, setIsResponseOpen] = useState(true);
  const [isMoreAttributesOpen, setIsMoreAttributesOpen] = useState(false);
  const [isMergedView, setIsMergedView] = useState(true);

  const abortControllerRef = useRef<AbortController | null>(null);

  const alerts = useQuery(api.alerts.listEnabled);

  const parsedAttributes = useMemo(
    () => (request?.SpanAttributes ? parseSpanAttributes(request.SpanAttributes) : {}),
    [request?.SpanAttributes],
  );

  const requestId = parsedAttributes['gen_ai.request_id'];
  const provider = parsedAttributes['gen_ai.system'] ?? '';
  const model = parsedAttributes['gen_ai.request.model'] ?? '';
  const targetUrl = parsedAttributes['http.url'] ?? '';
  const statusCode = parsedAttributes['http.response.status_code'] ?? '';
  const responseId = parsedAttributes['gen_ai.response.id'] ?? '';

  const remainingAttributes = useMemo(() => {
    const displayedKeys = new Set([
      'gen_ai.system',
      'gen_ai.request.model',
      'http.url',
      'http.response.status_code',
      'gen_ai.response.id',
      'gen_ai.request_id',
      'service.name',
    ]);
    return Object.entries(parsedAttributes).filter(([key]) => !displayedKeys.has(key));
  }, [parsedAttributes]);

  const triggeredAlerts = useMemo(() => {
    if (!alerts || alerts.length === 0 || !request) return [];
    const alertSummary = evaluateAlertsForTraces([request], alerts);
    return alertSummary.get(request.TraceId)?.triggeredAlerts ?? [];
  }, [alerts, request]);

  const highestSeverity = useMemo(() => {
    if (triggeredAlerts.length === 0) return null;
    return getHighestSeverity(triggeredAlerts.map((t) => t.alert.severity as AlertSeverity));
  }, [triggeredAlerts]);

  // Fetch bodies when requestId changes, with AbortController
  useEffect(() => {
    // Cancel any in-flight fetches
    abortControllerRef.current?.abort();

    if (!requestId || !isOpen) {
      setRequestBody(null);
      setResponseBody(null);
      setBodiesLoading(false);
      setBodiesError(null);
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setRequestBody(null);
    setResponseBody(null);
    setBodiesError(null);
    setBodiesLoading(true);

    const fetchBodies = async () => {
      const tokenRes = await fetch('/api/token', { signal: controller.signal });
      if (!tokenRes.ok) {
        window.location.href = `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const { token } = await tokenRes.json();

      const storedBodies = await fetchStoredBodies(requestId, token, controller.signal);
      if (controller.signal.aborted) return;

      const formattedBodies = formatStoredBodiesForDisplay(storedBodies);
      setRequestBody(formattedBodies.requestBody);
      setResponseBody(formattedBodies.responseBody);
      setBodiesLoading(false);
    };

    fetchBodies().catch((err) => {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : 'Failed to fetch bodies';
        setBodiesError(message);
        setBodiesLoading(false);
      }
    });

    return () => {
      controller.abort();
    };
  }, [requestId, isOpen]);

  const formatDuration = (nanoseconds: number) => {
    const milliseconds = nanoseconds / 1_000_000;
    if (milliseconds < 1) return `${(milliseconds * 1000).toFixed(0)}us`;
    if (milliseconds < 1000) return `${milliseconds.toFixed(0)}ms`;
    return `${(milliseconds / 1000).toFixed(2)}s`;
  };

  const formatTimestamp = (nanoseconds: number) => {
    const milliseconds = nanoseconds / 1_000_000;
    return new Date(milliseconds).toLocaleString();
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

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="w-[560px] sm:max-w-[560px] overflow-y-auto p-0">
        <SheetHeader className="sticky top-0 z-10 flex-row items-center justify-between border-b border-border/50 bg-background px-6 py-4 space-y-0">
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-base font-medium">
              {request?.SpanName ?? 'Request Details'}
            </SheetTitle>
            <SheetDescription className="mt-0.5 font-mono text-xs">
              {request?.TraceId ?? ''}
            </SheetDescription>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {highestSeverity && (
              <AlertBadge severity={highestSeverity} count={triggeredAlerts.length} size="md" />
            )}
            {request && (
              <>
                <span
                  className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                    request.StatusCode === 'ERROR'
                      ? 'bg-red-500/15 text-red-400'
                      : request.StatusCode === 'OK'
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {request.StatusCode}
                </span>
                <span className="font-mono text-sm tabular-nums text-muted-foreground">
                  {formatDuration(request.Duration)}
                </span>
                <Link
                  href={`/app/trace/${request.TraceId}`}
                  className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <span>View Trace</span>
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </>
            )}
          </div>
        </SheetHeader>

        {request && (
          <div className="space-y-5 p-6">
            {/* Alerts */}
            {triggeredAlerts.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-foreground">Triggered Alerts</h3>
                <AlertList triggeredAlerts={triggeredAlerts} />
              </div>
            )}

            {/* Key Attributes */}
            <div className="space-y-3">
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
                    value={formatModelDisplay(model, provider ?? undefined)}
                    mono
                  />
                )}
                {statusCode && (
                  <AttributeCard
                    icon={<Hash className="h-3.5 w-3.5" />}
                    label="HTTP Status"
                    value={statusCode}
                    mono
                  />
                )}
                <AttributeCard
                  icon={<Clock className="h-3.5 w-3.5" />}
                  label="Timestamp"
                  value={formatTimestamp(request.Timestamp)}
                />
              </div>

              {targetUrl && (
                <div className="grid grid-cols-1 gap-2">
                  <AttributeCard
                    icon={<Link2 className="h-3.5 w-3.5" />}
                    label="Endpoint"
                    value={targetUrl}
                    mono
                  />
                </div>
              )}

              {responseId && (
                <div className="grid grid-cols-1 gap-2">
                  <AttributeCard
                    icon={<FileJson className="h-3.5 w-3.5" />}
                    label="Response ID"
                    value={responseId}
                    mono
                  />
                </div>
              )}

              {remainingAttributes.length > 0 && (
                <Collapsible open={isMoreAttributesOpen} onOpenChange={setIsMoreAttributesOpen}>
                  <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                    <ChevronDown
                      className={`h-3 w-3 transition-transform ${isMoreAttributesOpen ? 'rotate-0' : '-rotate-90'}`}
                    />
                    <span>{remainingAttributes.length} more attributes</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2 grid grid-cols-1 gap-1.5 rounded-lg border border-border/30 bg-muted/10 p-3">
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

            <div className="border-t border-border/30" />

            {/* Response Body */}
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
                  {bodiesError ? (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                      <p className="text-sm text-red-400">{bodiesError}</p>
                    </div>
                  ) : bodiesLoading ? (
                    <BodySkeleton />
                  ) : (
                    renderBodyContent(responseBody, true)
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Request Body */}
            <Collapsible open={isRequestOpen} onOpenChange={setIsRequestOpen}>
              <CollapsibleTrigger className="flex items-center gap-2 text-left transition-colors hover:opacity-70">
                <ChevronDown
                  className={`h-4 w-4 text-muted-foreground transition-transform ${isRequestOpen ? 'rotate-0' : '-rotate-90'}`}
                />
                <span className="text-sm font-medium text-foreground">Request</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-3">
                  {bodiesError ? (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                      <p className="text-sm text-red-400">{bodiesError}</p>
                    </div>
                  ) : bodiesLoading ? (
                    <BodySkeleton />
                  ) : (
                    renderBodyContent(requestBody)
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
