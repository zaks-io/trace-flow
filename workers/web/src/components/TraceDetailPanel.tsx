'use client';

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { TraceDetailContent, type TraceSpan } from './TraceDetailContent';
import { SpanGanttChart } from './SpanGanttChart';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';

interface TraceDetailPanelProps {
  traceId: string;
  isOpen: boolean;
  onClose: () => void;
}

interface TinybirdResponse {
  data: TraceSpan[];
}

export function TraceDetailPanel({ traceId, isOpen, onClose }: TraceDetailPanelProps) {
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
    enabled: isOpen && !!traceId,
  });

  const spans = data?.data ?? [];

  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Trace Details</SheetTitle>
        </SheetHeader>

        <div className="space-y-6 px-4">
          <Link
            href={`/app/request?id=${traceId}`}
            className="flex w-fit items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <span>View Full Page</span>
            <ExternalLink className="h-4 w-4" />
          </Link>
          {spans.length > 0 && (
            <section>
              <h2 className="mb-4 text-xl font-semibold text-foreground">Span Timeline</h2>
              <SpanGanttChart spans={spans} />
            </section>
          )}

          <TraceDetailContent traceId={traceId} enabled={isOpen} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
