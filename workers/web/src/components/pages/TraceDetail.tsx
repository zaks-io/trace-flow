import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronRight, Copy, Check, ExternalLink } from 'lucide-react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { TokenSummaryCards } from '@/components/TokenSummaryCards';
import { AgentGanttChart } from '@/components/AgentGanttChart';
import { SpanDetailPanel } from '@/components/SpanDetailPanel';

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
  const { traceId } = useParams<{ traceId: string }>();
  const [copied, setCopied] = useState(false);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  const { data, loading, error } = useTinybirdQuery<TinybirdResponse>({
    sql: `SELECT
      ReceivedAt, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, ServiceName,
      Duration, StatusCode, StatusMessage, SpanAttributes, ResourceAttributes,
      Events.Timestamp, Events.Name, Events.Attributes
    FROM otel_traces
    WHERE TraceId = '${traceId}'
    ORDER BY Timestamp ASC
    FORMAT JSON`,
    scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
    enabled: !!traceId,
  });

  const spans = data?.data ?? [];
  const rootSpan = spans.find((s) => s.ParentSpanId === '');
  const selectedSpan = spans.find((s) => s.SpanId === selectedSpanId);

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

  if (!traceId) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <h1 className="mb-2 text-xl font-semibold text-foreground">No Trace ID Provided</h1>
          <p className="mb-4 text-sm text-muted-foreground">
            Please select a trace from the traces list.
          </p>
          <Link to="/traces" className="text-sm text-primary underline hover:text-primary/80">
            Go to Traces
          </Link>
        </div>
      </div>
    );
  }

  if (loading) {
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
    <div className="animate-fade-in space-y-6">
      <div className="flex items-center justify-between">
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

      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Trace Details</h1>
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{traceId}</p>
      </div>

      <TokenSummaryCards spans={spans} />

      <div className="flex gap-6">
        <div className={`flex-1 ${selectedSpan ? 'max-w-[calc(100%-384px)]' : ''}`}>
          <h2 className="mb-3 text-lg font-semibold text-foreground">Span Timeline</h2>
          <AgentGanttChart
            spans={spans}
            selectedSpanId={selectedSpanId ?? undefined}
            onSpanSelect={handleSpanSelect}
          />
        </div>

        {selectedSpan && (
          <div className="w-96 shrink-0">
            <SpanDetailPanel
              span={selectedSpan}
              isRootSpan={selectedSpan.ParentSpanId === ''}
              onClose={() => setSelectedSpanId(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
