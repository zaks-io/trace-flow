'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { ChevronRight, Copy, Check, ExternalLink, FileText, Hash } from 'lucide-react';
import { type Preloaded, usePreloadedQuery } from 'convex/react';
import { type api } from '@trace-flow/convex/_generated/api';
import { validateTraceId } from '@trace-flow/utils';
import { useLiveTraceDetail } from '@/hooks/useLiveTraceDetail';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { TokenSummaryCards } from '@/components/traces/TokenSummaryCards';
import { SpanDetailPanel } from '@/components/traces/SpanDetailPanel';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertBadge } from '@/components/alerts';
import {
  evaluateAlertsForTraces,
  evaluateAlertsForSpans,
  traceSpanToRequestRow,
  getHighestSeverity,
} from '@/lib/alerts';
import { generateTraceMarkdown, estimateMarkdownTokens } from '@/lib/traceToMarkdown';
import type { AlertSeverity } from '@/types/alerts';
import { isLLMRequestSpan } from '@/lib/spans';

const AgentGanttChart = dynamic(
  () =>
    import('@/components/traces/AgentGanttChart').then((mod) => ({ default: mod.AgentGanttChart })),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-2 p-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-8 w-5/6" />
      </div>
    ),
  },
);

interface TraceDetailProps {
  traceId?: string;
  preloadedAlerts: Preloaded<typeof api.alerts.listEnabled>;
}

export default function TraceDetail({ traceId, preloadedAlerts }: TraceDetailProps) {
  const [copied, setCopied] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  const validatedTraceId = validateTraceId(traceId);
  const alerts = usePreloadedQuery(preloadedAlerts);

  const { spans, loading, error } = useLiveTraceDetail({
    traceId: validatedTraceId,
    enabled: !!validatedTraceId,
  });
  const rootSpan = spans.find((s) => s.ParentSpanId === '');
  const requestSpans = spans.filter(isLLMRequestSpan);
  const selectedSpan = spans.find((s) => s.SpanId === selectedSpanId);

  const { triggeredAlerts, spanAlertSummary } = useMemo(() => {
    if (!alerts || alerts.length === 0 || requestSpans.length === 0 || !validatedTraceId) {
      return { triggeredAlerts: [], spanAlertSummary: new Map() };
    }
    const requestRows = requestSpans.map(traceSpanToRequestRow);
    const traceAlertSummary = evaluateAlertsForTraces(requestRows, alerts);
    const spanSummary = evaluateAlertsForSpans(requestRows, alerts);
    return {
      triggeredAlerts: traceAlertSummary.get(validatedTraceId)?.triggeredAlerts ?? [],
      spanAlertSummary: spanSummary,
    };
  }, [alerts, requestSpans, validatedTraceId]);

  const highestSeverity = useMemo(() => {
    if (triggeredAlerts.length === 0) return null;
    return getHighestSeverity(triggeredAlerts.map((t) => t.alert.severity as AlertSeverity));
  }, [triggeredAlerts]);

  const estimatedTokens = useMemo(() => {
    if (spans.length === 0) return 0;
    return estimateMarkdownTokens(spans);
  }, [spans]);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  };

  const handleCopyId = async () => {
    if (!traceId) return;
    try {
      await navigator.clipboard.writeText(traceId);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    } catch (err) {
      console.error('Failed to copy ID:', err);
    }
  };

  const handleCopyMarkdown = async () => {
    try {
      const markdown = generateTraceMarkdown(spans);
      await navigator.clipboard.writeText(markdown);
      setCopiedMarkdown(true);
      setTimeout(() => setCopiedMarkdown(false), 2000);
    } catch (err) {
      console.error('Failed to copy markdown:', err);
    }
  };

  const handleSpanSelect = (spanId: string) => {
    setSelectedSpanId(spanId === selectedSpanId ? null : spanId);
  };

  if (!traceId || !validatedTraceId) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        <PageToolbar />
        <div className="flex min-h-[400px] items-center justify-center">
          <div className="text-center">
            <h1 className="mb-2 text-xl font-semibold text-foreground">
              {traceId ? 'Invalid Trace ID' : 'No Trace ID Provided'}
            </h1>
            <p className="mb-4 text-sm text-muted-foreground">
              {traceId
                ? 'The provided trace ID is not a valid 32-character hex string.'
                : 'Please select a trace from the traces list.'}
            </p>
            <Link
              href="/app/traces"
              className="text-sm text-primary underline hover:text-primary/80"
            >
              Go to Traces
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        <PageToolbar />
        <div className="flex min-h-[400px] items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Loading trace...
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        <PageToolbar />
        <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-4">
          <h3 className="mb-2 font-semibold text-destructive">Error loading trace</h3>
          <p className="text-sm text-destructive/80">{error.message}</p>
        </div>
      </div>
    );
  }

  if (spans.length === 0) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        <PageToolbar />
        <div className="flex min-h-[400px] items-center justify-center">
          <div className="text-center">
            <h1 className="mb-2 text-xl font-semibold text-foreground">Trace Not Found</h1>
            <p className="mb-4 text-sm text-muted-foreground">
              The trace with ID {traceId} could not be found.
            </p>
            <Link
              href="/app/traces"
              className="text-sm text-primary underline hover:text-primary/80"
            >
              Go to Traces
            </Link>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="animate-fade-in flex flex-1 min-h-0 flex-col">
      <PageToolbar>
        <nav className="flex items-center space-x-2 text-sm">
          <Link
            href="/app/traces"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Traces
          </Link>
          <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
          <span className="font-mono font-medium text-foreground">{traceId}</span>
          {highestSeverity && (
            <AlertBadge severity={highestSeverity} count={triggeredAlerts.length} size="md" />
          )}
        </nav>

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          {rootSpan?.ParentSpanId && rootSpan.ParentSpanId !== '' && (
            <Link
              href={`/app/trace/${rootSpan.ParentSpanId}`}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>View Parent</span>
            </Link>
          )}

          <button
            onClick={() => void handleCopyMarkdown()}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {copiedMarkdown ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-emerald-400">Copied!</span>
              </>
            ) : (
              <>
                <FileText className="h-3.5 w-3.5" />
                <span>
                  Copy Markdown
                  {estimatedTokens > 0 && (
                    <span className="ml-1 text-muted-foreground/70">
                      (~
                      {estimatedTokens >= 1000
                        ? `${(estimatedTokens / 1000).toFixed(1)}k`
                        : estimatedTokens}
                      t)
                    </span>
                  )}
                </span>
              </>
            )}
          </button>

          <button
            onClick={() => void handleCopyId()}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {copiedId ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-emerald-400">Copied!</span>
              </>
            ) : (
              <>
                <Hash className="h-3.5 w-3.5" />
                <span>Copy ID</span>
              </>
            )}
          </button>

          <button
            onClick={() => void handleCopyLink()}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-emerald-400">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Copy Link</span>
              </>
            )}
          </button>
        </div>
      </PageToolbar>

      <div className="mt-4 shrink-0">
        <TokenSummaryCards spans={spans} />
      </div>

      {/* Span Timeline */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AgentGanttChart
            spans={spans}
            selectedSpanId={selectedSpanId ?? undefined}
            onSpanSelect={handleSpanSelect}
            spanAlertSummary={spanAlertSummary}
          />
        </div>
      </div>

      <SpanDetailPanel
        span={selectedSpan ?? null}
        rootSpan={rootSpan ?? null}
        allSpans={spans}
        isRootSpan={
          selectedSpan ? selectedSpan.ParentSpanId === '' || isLLMRequestSpan(selectedSpan) : false
        }
        isOpen={!!selectedSpan}
        onClose={() => setSelectedSpanId(null)}
        triggeredAlerts={
          selectedSpanId ? spanAlertSummary.get(selectedSpanId)?.triggeredAlerts : undefined
        }
      />
    </div>
  );
}
