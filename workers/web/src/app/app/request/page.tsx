'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, Copy, Check } from 'lucide-react';
import { TraceDetailContent } from '@/components/TraceDetailContent';
import { SpanGanttChart } from '@/components/SpanGanttChart';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';

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

interface TinybirdResponse {
  data: TraceSpan[];
}

export default function RequestDetailPage() {
  const searchParams = useSearchParams();
  const traceId = searchParams.get('id');
  const [copied, setCopied] = useState(false);

  const { data } = useTinybirdQuery<TinybirdResponse>({
    sql: `SELECT
      Timestamp, TraceId, SpanId, ParentSpanId, SpanName, ServiceName,
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

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  };

  if (!traceId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <h1 className="mb-2 text-2xl font-bold text-foreground">No Trace ID Provided</h1>
          <p className="mb-4 text-muted-foreground">
            Please select a request from the requests list.
          </p>
          <Link href="/app/requests" className="text-primary underline hover:text-primary/80">
            Go to Requests
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-10 border-b border-border bg-card">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <nav className="flex items-center space-x-2 text-sm">
              <Link
                href="/app/requests"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                Requests
              </Link>
              <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
              <span className="font-medium text-foreground">
                {rootSpan?.SpanName ?? 'Trace Details'}
              </span>
            </nav>

            <button
              onClick={() => void handleCopyLink()}
              className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 text-emerald-400" />
                  <span className="text-emerald-400">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  <span>Copy Link</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-8">
          <h1 className="mb-2 text-2xl font-bold text-foreground">Trace Details</h1>
          <p className="break-all font-mono text-sm text-muted-foreground">{traceId}</p>
        </div>

        {spans.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-4 text-xl font-semibold text-foreground">Span Timeline</h2>
            <SpanGanttChart spans={spans} />
          </section>
        )}

        <TraceDetailContent traceId={traceId} />
      </div>
    </div>
  );
}
