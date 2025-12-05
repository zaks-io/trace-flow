import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronRight, Copy, Check } from 'lucide-react';
import { validateTraceId } from '@trace-flow/utils';
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

function truncateId(id: string) {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
}

export default function SpanGroupDetail() {
  const { parentSpanId } = useParams<{ parentSpanId: string }>();
  const [copied, setCopied] = useState(false);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  const validatedParentSpanId = validateTraceId(parentSpanId);

  const {
    data,
    loading,
    error,
  }: {
    data: TinybirdResponse | null;
    loading: boolean;
    error: Error | null;
  } = useTinybirdQuery<TinybirdResponse>({
    sql: validatedParentSpanId
      ? `SELECT
      ReceivedAt, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, ServiceName,
      Duration, StatusCode, StatusMessage, SpanAttributes, ResourceAttributes,
      Events.Timestamp, Events.Name, Events.Attributes
    FROM otel_traces
    WHERE TraceId IN (
      SELECT DISTINCT TraceId FROM otel_traces WHERE ParentSpanId = '${validatedParentSpanId}'
    )
    ORDER BY Timestamp ASC
    FORMAT JSON`
      : '',
    scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
    enabled: !!validatedParentSpanId,
  });

  const spans = data?.data ?? [];
  const uniqueTraceIds = [...new Set(spans.map((s) => s.TraceId))];
  const selectedSpan = spans.find((s) => s.SpanId === selectedSpanId);

  // Count llm.request spans to show the number of actual requests
  const spanCounts = spans.reduce<Record<string, number>>((acc, s) => {
    acc[s.SpanName] = (acc[s.SpanName] ?? 0) + 1;
    return acc;
  }, {});
  const llmRequestCount = spanCounts['llm.request'] ?? 0;

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

  if (!parentSpanId || !validatedParentSpanId) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <h1 className="mb-2 text-xl font-semibold text-foreground">
            {parentSpanId ? 'Invalid Parent Span ID' : 'No Parent Span ID Provided'}
          </h1>
          <p className="mb-4 text-sm text-muted-foreground">
            {parentSpanId
              ? 'The provided parent span ID is not a valid 32-character hex string.'
              : 'Please select a span group from the spans list.'}
          </p>
          <Link to="/spans" className="text-sm text-primary underline hover:text-primary/80">
            Go to Spans
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
          Loading span group...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-4">
        <h3 className="mb-2 font-semibold text-destructive">Error loading span group</h3>
        <p className="text-sm text-destructive/80">{error.message}</p>
      </div>
    );
  }

  if (spans.length === 0) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <h1 className="mb-2 text-xl font-semibold text-foreground">Span Group Not Found</h1>
          <p className="mb-4 text-sm text-muted-foreground">
            No spans found with parent span ID {truncateId(parentSpanId)}.
          </p>
          <Link to="/spans" className="text-sm text-primary underline hover:text-primary/80">
            Go to Spans
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
            to="/spans"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Spans
          </Link>
          <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
          <span className="font-medium text-foreground">Span Group</span>
        </nav>

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

      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Span Group</h1>
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{parentSpanId}</p>
        <div className="mt-2 flex items-center gap-4 text-sm text-muted-foreground">
          <span>
            {llmRequestCount} {llmRequestCount === 1 ? 'request' : 'requests'}
          </span>
          <span>•</span>
          <span>
            {spans.length} {spans.length === 1 ? 'span' : 'spans'}
          </span>
          <span>•</span>
          <span>
            {uniqueTraceIds.length} {uniqueTraceIds.length === 1 ? 'trace' : 'traces'}
          </span>
        </div>
      </div>

      <TokenSummaryCards spans={spans} />

      <div>
        <h2 className="mb-3 text-lg font-semibold text-foreground">Span Timeline</h2>
        <AgentGanttChart
          spans={spans}
          selectedSpanId={selectedSpanId ?? undefined}
          onSpanSelect={handleSpanSelect}
          parentSpanId={parentSpanId}
        />
      </div>

      <SpanDetailPanel
        span={selectedSpan ?? null}
        isRootSpan={selectedSpan ? selectedSpan.ParentSpanId === parentSpanId : false}
        isOpen={!!selectedSpan}
        onClose={() => setSelectedSpanId(null)}
      />
    </div>
  );
}
