'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { TraceDetailPanel } from '@/components/TraceDetailPanel';

interface RequestRow {
  Timestamp: number;
  TraceId: string;
  SpanId: string;
  SpanName: string;
  ServiceName: string;
  Duration: number;
  StatusCode: string;
}

interface TinybirdResponse {
  data: RequestRow[];
}

export default function Requests() {
  const router = useRouter();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  const {
    data,
    loading,
    error,
  }: { data: TinybirdResponse | null; loading: boolean; error: Error | null } =
    useTinybirdQuery<TinybirdResponse>({
      sql: `SELECT Timestamp, TraceId, SpanId, SpanName, ServiceName, Duration, StatusCode
        FROM otel_traces
        WHERE ParentSpanId = ''
        ORDER BY Timestamp DESC
        LIMIT 100
        FORMAT JSON`,
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

  const handleRowClick = (traceId: string, event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey) {
      setSelectedTraceId(traceId);
      setIsPanelOpen(true);
    } else {
      router.push(`/app/request?id=${traceId}`);
    }
  };

  const handleClosePanel = () => {
    setIsPanelOpen(false);
    setTimeout(() => setSelectedTraceId(null), 300);
  };

  const requests = data?.data ?? [];

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="text-gray-600">Loading requests...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h3 className="text-red-800 font-semibold mb-2">Error loading requests</h3>
        <p className="text-red-600 text-sm">{error.message}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">LLM Requests</h1>
        <p className="text-gray-600 mt-1">
          Root traces from your LLM requests. Click a row to view full details, or Cmd/Ctrl+click
          for quick preview.
        </p>
      </div>

      {requests.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No requests found</p>
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
                    Request Name
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
                {requests.map((request) => (
                  <tr
                    key={`${request.TraceId}-${request.SpanId}`}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={(e) => handleRowClick(request.TraceId, e)}
                  >
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {formatTimestamp(request.Timestamp)}
                    </td>
                    <td
                      className="px-6 py-4 whitespace-nowrap text-sm text-gray-600 font-mono"
                      title={request.TraceId}
                    >
                      {truncateId(request.TraceId)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {request.SpanName}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {request.ServiceName}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {formatDuration(request.Duration)}
                    </td>
                    <td
                      className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${getStatusColor(request.StatusCode)}`}
                    >
                      {request.StatusCode}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="bg-gray-50 px-6 py-3 border-t border-gray-200">
            <p className="text-sm text-gray-600">
              Showing {requests.length} {requests.length === 1 ? 'request' : 'requests'}
            </p>
          </div>
        </div>
      )}

      {selectedTraceId && (
        <TraceDetailPanel
          traceId={selectedTraceId}
          isOpen={isPanelOpen}
          onClose={handleClosePanel}
        />
      )}
    </div>
  );
}
