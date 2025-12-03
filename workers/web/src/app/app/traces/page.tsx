'use client';

import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';

interface TraceRow {
  ReceivedAt: number;
  Timestamp: number;
  TraceId: string;
  SpanId: string;
  SpanName: string;
  ServiceName: string;
  Duration: number;
  StatusCode: string;
}

interface TinybirdResponse {
  data: TraceRow[];
}

export default function Traces() {
  const {
    data,
    loading,
    error,
  }: { data: TinybirdResponse | null; loading: boolean; error: Error | null } =
    useTinybirdQuery<TinybirdResponse>({
      sql: 'SELECT ReceivedAt, Timestamp, TraceId, SpanId, SpanName, ServiceName, Duration, StatusCode FROM otel_traces ORDER BY ReceivedAt DESC LIMIT 100 FORMAT JSON',
      scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
    });

  const formatTimestamp = (nanoseconds: number) => {
    const milliseconds = nanoseconds / 1_000_000;
    return new Date(milliseconds).toLocaleString();
  };

  const formatDuration = (nanoseconds: number) => {
    const milliseconds = nanoseconds / 1_000_000;
    return `${milliseconds.toFixed(2)}ms`;
  };

  const truncateId = (id: string) => {
    return id.length > 16 ? `${id.slice(0, 16)}...` : id;
  };

  const traces = data?.data ?? [];

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
        <div className="card-elevated overflow-hidden rounded-xl border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Received At
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Timestamp
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Trace ID
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Span Name
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Service
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Duration
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {traces.map((trace) => (
                  <tr key={`${trace.TraceId}-${trace.SpanId}`} className="table-row-interactive">
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-foreground">
                      {formatTimestamp(trace.ReceivedAt)}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-muted-foreground">
                      {formatTimestamp(trace.Timestamp)}
                    </td>
                    <td
                      className="whitespace-nowrap px-6 py-4 text-sm text-muted-foreground"
                      title={trace.TraceId}
                    >
                      <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs">
                        {truncateId(trace.TraceId)}
                      </code>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-foreground">
                      {trace.SpanName}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-muted-foreground">
                      {trace.ServiceName}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 font-mono text-sm text-foreground">
                      {formatDuration(trace.Duration)}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          trace.StatusCode === 'OK' || trace.StatusCode === 'UNSET'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : trace.StatusCode === 'ERROR'
                              ? 'bg-destructive/20 text-destructive'
                              : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {trace.StatusCode}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border bg-muted/20 px-6 py-3">
            <p className="text-xs text-muted-foreground">
              Showing {traces.length} {traces.length === 1 ? 'trace' : 'traces'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
