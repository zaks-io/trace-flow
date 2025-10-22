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
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">No Trace ID Provided</h1>
          <p className="text-gray-600 mb-4">Please select a request from the requests list.</p>
          <Link href="/app/requests" className="text-blue-600 hover:text-blue-700 underline">
            Go to Requests
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="border-b bg-white sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <nav className="flex items-center space-x-2 text-sm">
              <Link
                href="/app/requests"
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                Requests
              </Link>
              <ChevronRight className="h-4 w-4 text-gray-400" />
              <span className="text-gray-900 font-medium">
                {rootSpan?.SpanName ?? 'Trace Details'}
              </span>
            </nav>

            <button
              onClick={() => void handleCopyLink()}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 text-green-600" />
                  <span className="text-green-600">Copied!</span>
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

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Trace Details</h1>
          <p className="text-sm text-gray-500 font-mono break-all">{traceId}</p>
        </div>

        {spans.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Span Timeline</h2>
            <SpanGanttChart spans={spans} />
          </section>
        )}

        <TraceDetailContent traceId={traceId} />
      </div>
    </div>
  );
}
