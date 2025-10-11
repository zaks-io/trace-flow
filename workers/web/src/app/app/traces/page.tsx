'use client';

import { Authenticated, Unauthenticated, AuthLoading } from 'convex/react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';

interface TraceRow {
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
  const { data, loading, error } = useTinybirdQuery<TinybirdResponse>({
    sql: 'SELECT Timestamp, TraceId, SpanId, SpanName, ServiceName, Duration, StatusCode FROM otel_traces ORDER BY Timestamp DESC LIMIT 100 FORMAT JSON',
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

  const getStatusColor = (status: string) => {
    switch (status.toUpperCase()) {
      case 'OK':
      case 'UNSET':
        return 'text-green-600';
      case 'ERROR':
        return 'text-red-600';
      default:
        return 'text-gray-600';
    }
  };

  const truncateId = (id: string) => {
    return id.length > 16 ? `${id.slice(0, 16)}...` : id;
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="text-gray-600">Loading traces...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h3 className="text-red-800 font-semibold mb-2">Error loading traces</h3>
        <p className="text-red-600 text-sm">{error.message}</p>
      </div>
    );
  }

  const traces = data?.data ?? [];

  return (
    <>
      <AuthLoading>
        <div className="flex justify-center items-center py-12">
          <div className="text-gray-600">Loading...</div>
        </div>
      </AuthLoading>
      <Unauthenticated>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-8 text-center">
          <h2 className="text-xl font-semibold text-blue-900 mb-2">Authentication Required</h2>
          <p className="text-blue-700">Please log in to view traces.</p>
        </div>
      </Unauthenticated>
      <Authenticated>
        <div>
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900">Traces</h1>
            <p className="text-gray-600 mt-1">Recent OpenTelemetry traces from your LLM requests</p>
          </div>

          {traces.length === 0 ? (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
              <p className="text-gray-600">No traces found</p>
            </div>
          ) : (
            <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Timestamp
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Trace ID
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Span Name
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Service
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Duration
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {traces.map((trace) => (
                      <tr key={`${trace.TraceId}-${trace.SpanId}`} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {formatTimestamp(trace.Timestamp)}
                        </td>
                        <td
                          className="px-6 py-4 whitespace-nowrap text-sm text-gray-600 font-mono"
                          title={trace.TraceId}
                        >
                          {truncateId(trace.TraceId)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {trace.SpanName}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {trace.ServiceName}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {formatDuration(trace.Duration)}
                        </td>
                        <td
                          className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${getStatusColor(trace.StatusCode)}`}
                        >
                          {trace.StatusCode}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="bg-gray-50 px-6 py-3 border-t border-gray-200">
                <p className="text-sm text-gray-600">
                  Showing {traces.length} {traces.length === 1 ? 'trace' : 'traces'}
                </p>
              </div>
            </div>
          )}
        </div>
      </Authenticated>
    </>
  );
}
