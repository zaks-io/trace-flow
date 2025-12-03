'use client';

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { TraceDetailContent, type TraceSpan } from './TraceDetailContent';
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
  const rootSpan = spans.find((s) => s.ParentSpanId === '');

  const formatDuration = (nanoseconds: number) => {
    const milliseconds = nanoseconds / 1_000_000;
    if (milliseconds < 1) {
      return `${(milliseconds * 1000).toFixed(0)}μs`;
    }
    if (milliseconds < 1000) {
      return `${milliseconds.toFixed(0)}ms`;
    }
    return `${(milliseconds / 1000).toFixed(2)}s`;
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden p-0">
        <DialogHeader className="flex-shrink-0 border-b border-border/50 px-6 py-4">
          <div className="flex items-center justify-between pr-8">
            <div className="flex items-center gap-4">
              <div>
                <DialogTitle className="text-base font-medium text-foreground">
                  {rootSpan?.SpanName ?? 'Trace Details'}
                </DialogTitle>
                <DialogDescription className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {traceId}
                </DialogDescription>
              </div>
            </div>
            <div className="flex items-center gap-4">
              {rootSpan && (
                <>
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                        rootSpan.StatusCode === 'ERROR'
                          ? 'bg-red-500/15 text-red-400'
                          : rootSpan.StatusCode === 'OK'
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {rootSpan.StatusCode}
                    </span>
                  </div>
                  <span className="font-mono text-sm tabular-nums text-muted-foreground">
                    {formatDuration(rootSpan.Duration)}
                  </span>
                </>
              )}
              <Link
                href={`/app/request?id=${traceId}`}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <span>Full Page</span>
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          <div className="space-y-4 p-6">
            <TraceDetailContent traceId={traceId} enabled={isOpen} spans={spans} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
