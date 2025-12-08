import { useState, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronRight, Copy, Check, ExternalLink } from 'lucide-react';
import { useQuery } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import { validateTraceId } from '@trace-flow/utils';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { useUserApiKeys } from '@/hooks/useUserApiKeys';
import { usePageHeader } from '@/components/PageHeaderContext';
import { TokenSummaryCards } from '@/components/TokenSummaryCards';
import { AgentGanttChart } from '@/components/AgentGanttChart';
import { SpanDetailPanel } from '@/components/SpanDetailPanel';
import { AlertBadge } from '@/components/alerts';
import {
  evaluateAlertsForTraces,
  evaluateAlertsForSpans,
  traceSpanToRequestRow,
  getHighestSeverity,
} from '@/lib/alerts';
import type { AlertSeverity } from '@/types/alerts';

interface TraceSpan {
  ReceivedAt: number;
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

export default function TraceDetail() {
  usePageHeader('Trace Details');
  const { traceId } = useParams<{ traceId: string }>();
  const [copied, setCopied] = useState(false);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  const { keys: userApiKeys, isLoading: keysLoading } = useUserApiKeys();
  const validatedTraceId = validateTraceId(traceId);
  const alerts = useQuery(api.alerts.listEnabled);

  const { data, loading, error } = useTinybirdQuery<TinybirdResponse>({
    sql: validatedTraceId
      ? `SELECT
      ReceivedAt, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, ServiceName,
      Duration, StatusCode, StatusMessage, SpanAttributes, ResourceAttributes,
      Events.Timestamp, Events.Name, Events.Attributes
    FROM otel_traces
    WHERE TraceId = '${validatedTraceId}'
    ORDER BY Timestamp ASC
    FORMAT JSON`
      : '',
    scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
    enabled: !!validatedTraceId,
    apiKeys: userApiKeys,
  });

  const spans = data?.data ?? [];
  const rootSpan = spans.find((s) => s.ParentSpanId === '');
  const requestSpans = spans.filter((s) => s.SpanName === 'ai.request');
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

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  };

  const handleSpanSelect = (spanId: string) => {
    setSelectedSpanId(spanId === selectedSpanId ? null : spanId);
  };

  if (!traceId || !validatedTraceId) {
    return (
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
          <Link to="/traces" className="text-sm text-primary underline hover:text-primary/80">
            Go to Traces
          </Link>
        </div>
      </div>
    );
  }

  if (loading || keysLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading trace...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-4">
        <h3 className="mb-2 font-semibold text-destructive">Error loading trace</h3>
        <p className="text-sm text-destructive/80">{error.message}</p>
      </div>
    );
  }

  if (spans.length === 0) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <h1 className="mb-2 text-xl font-semibold text-foreground">Trace Not Found</h1>
          <p className="mb-4 text-sm text-muted-foreground">
            The trace with ID {traceId} could not be found.
          </p>
          <Link to="/traces" className="text-sm text-primary underline hover:text-primary/80">
            Go to Traces
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="animate-fade-in flex h-[calc(100vh-120px)] flex-col">
      {/* Header section */}
      <div className="flex shrink-0 items-center justify-between">
        <nav className="flex items-center space-x-2 text-sm">
          <Link
            to="/traces"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Traces
          </Link>
          <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
          <span className="font-medium text-foreground">
            {rootSpan?.SpanName ?? 'Trace Details'}
          </span>
          {highestSeverity && (
            <AlertBadge severity={highestSeverity} count={triggeredAlerts.length} size="md" />
          )}
        </nav>

        <div className="flex items-center gap-2">
          {rootSpan?.ParentSpanId && rootSpan.ParentSpanId !== '' && (
            <Link
              to={`/trace/${rootSpan.ParentSpanId}`}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>View Parent</span>
            </Link>
          )}

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
      </div>

      <p className="mt-4 shrink-0 break-all font-mono text-xs text-muted-foreground">{traceId}</p>

      <div className="mt-4 shrink-0">
        <TokenSummaryCards spans={spans} />
      </div>

      {/* Span Timeline */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <h2 className="mb-3 shrink-0 text-lg font-semibold text-foreground">Span Timeline</h2>
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
          selectedSpan
            ? selectedSpan.ParentSpanId === '' || selectedSpan.SpanName === 'ai.request'
            : false
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
