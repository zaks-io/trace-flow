'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { validateTraceId } from '@trace-flow/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { TraceDetailContent, type TraceSpan } from './TraceDetailContent';
import { useTinybirdPipe } from '@/hooks/useTinybirdPipe';
import { AlertBadge, AlertList } from '@/components/alerts';
import { evaluateAlertsForTraces, traceSpanToRequestRow, getHighestSeverity } from '@/lib/alerts';
import type { AlertSeverity } from '@/types/alerts';
import { isLLMRequestSpan } from '@/lib/spans';

interface TraceDetailPanelProps {
  traceId: string;
  requestId?: string;
  isOpen: boolean;
  onClose: () => void;
}

interface TinybirdResponse {
  data: TraceSpan[];
}

export function TraceDetailPanel({ traceId, requestId, isOpen, onClose }: TraceDetailPanelProps) {
  const validatedTraceId = validateTraceId(traceId);
  const alerts = useQuery(api.alerts.listEnabled);

  // API key filtering is now handled server-side via JWT fixed_params
  const { data } = useTinybirdPipe<TinybirdResponse>({
    pipe: 'trace_detail',
    params: validatedTraceId ? { trace_id: validatedTraceId } : undefined,
    enabled: isOpen && !!validatedTraceId,
  });

  const spans = data?.data ?? [];
  const requestSpans = spans.filter(isLLMRequestSpan);
  const rootSpan = requestSpans[0];

  const triggeredAlerts = useMemo(() => {
    if (!alerts || alerts.length === 0 || requestSpans.length === 0 || !validatedTraceId) {
      return [];
    }
    const requestRows = requestSpans.map(traceSpanToRequestRow);
    const alertSummary = evaluateAlertsForTraces(requestRows, alerts);
    return alertSummary.get(validatedTraceId)?.triggeredAlerts ?? [];
  }, [alerts, requestSpans, validatedTraceId]);

  const highestSeverity = useMemo(() => {
    if (triggeredAlerts.length === 0) return null;
    return getHighestSeverity(triggeredAlerts.map((t) => t.alert.severity as AlertSeverity));
  }, [triggeredAlerts]);

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
              {highestSeverity && (
                <AlertBadge severity={highestSeverity} count={triggeredAlerts.length} size="md" />
              )}
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
                href={`/app/trace/${traceId}`}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <span>View Trace</span>
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          <div className="space-y-4 p-6">
            {triggeredAlerts.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-foreground">Triggered Alerts</h3>
                <AlertList triggeredAlerts={triggeredAlerts} />
              </div>
            )}
            <TraceDetailContent
              traceId={traceId}
              requestId={requestId}
              enabled={isOpen}
              spans={spans}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
