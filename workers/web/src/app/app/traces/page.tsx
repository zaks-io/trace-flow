'use client';

import { useCallback } from 'react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { useColumnVisibility } from '@/hooks/useColumnVisibility';
import {
  DataTable,
  allColumns,
  defaultColumnVisibility,
  type TraceRow,
} from '@/components/traces-table';

interface TinybirdResponse {
  data: TraceRow[];
}

const STORAGE_KEY = 'observe-traces-columns';

export default function Traces() {
  const {
    data,
    loading,
    error,
  }: { data: TinybirdResponse | null; loading: boolean; error: Error | null } =
    useTinybirdQuery<TinybirdResponse>({
      sql: `SELECT ReceivedAt, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, ServiceName, Duration, StatusCode, SpanAttributes
        FROM otel_traces
        ORDER BY ReceivedAt DESC
        LIMIT 100
        FORMAT JSON`,
      scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
    });

  const { visibility, setVisibility } = useColumnVisibility(defaultColumnVisibility, STORAGE_KEY);

  const traces = data?.data ?? [];

  const getRowId = useCallback((row: TraceRow) => `${row.TraceId}-${row.SpanId}`, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading traces...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-4">
        <h3 className="mb-2 font-semibold text-destructive">Error loading traces</h3>
        <p className="text-sm text-destructive/80">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Traces</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Recent OpenTelemetry traces from your requests
        </p>
      </div>

      {traces.length === 0 ? (
        <div className="card-elevated rounded-xl border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground">No traces found</p>
          <p className="mt-1 text-sm text-muted-foreground/70">
            Traces will appear here once your proxy receives traffic
          </p>
        </div>
      ) : (
        <DataTable
          columns={allColumns}
          data={traces}
          columnVisibility={visibility}
          onColumnVisibilityChange={setVisibility}
          getRowId={getRowId}
        />
      )}
    </div>
  );
}
