'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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
  const searchParams = useSearchParams();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [mergedRequests, setMergedRequests] = useState<RequestRow[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [autoStoppedLiveMode, setAutoStoppedLiveMode] = useState(false);

  // Use ref to track latest timestamp without causing query re-evaluation
  const latestTimestampRef = useRef<number | null>(null);
  // Use ref to track if we're intentionally closing to prevent URL sync from reopening
  const isClosingRef = useRef(false);

  // Keep SQL query stable - don't change it based on latestTimestamp
  // In live mode, we'll fetch full dataset and filter client-side
  const sqlQuery = useMemo(() => {
    return `SELECT Timestamp, TraceId, SpanId, SpanName, ServiceName, Duration, StatusCode
      FROM otel_traces
      WHERE ParentSpanId = ''
      ORDER BY Timestamp DESC
      LIMIT 100
      FORMAT JSON`;
  }, []);

  const {
    data,
    loading,
    error,
    refetch,
  }: {
    data: TinybirdResponse | null;
    loading: boolean;
    error: Error | null;
    refetch: () => Promise<void>;
  } = useTinybirdQuery<TinybirdResponse>({
    sql: sqlQuery,
    scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
    pollInterval: isLiveMode ? 3000 : undefined,
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
      // Cmd/Ctrl+click opens full page in new tab
      window.open(`/app/request?id=${traceId}`, '_blank');
    } else {
      // Regular click opens sidebar
      isClosingRef.current = false; // Reset closing flag when opening
      setSelectedTraceId(traceId);
      setIsPanelOpen(true);
      // Update URL without navigation
      const params = new URLSearchParams(searchParams.toString());
      params.set('id', traceId);
      router.replace(`/app/requests?${params.toString()}`, { scroll: false });
    }
  };

  const handleClosePanel = useCallback(() => {
    isClosingRef.current = true;
    setIsPanelOpen(false);
    // Remove id from URL immediately when closing
    const params = new URLSearchParams(searchParams.toString());
    params.delete('id');
    const newUrl = params.toString() ? `/app/requests?${params.toString()}` : '/app/requests';
    router.replace(newUrl, { scroll: false });
    setTimeout(() => {
      setSelectedTraceId(null);
      // Reset flag after a delay to allow URL update to complete
      setTimeout(() => {
        isClosingRef.current = false;
      }, 100);
    }, 300);
  }, [searchParams, router]);

  // Handle URL query param on load (for shareable links)
  useEffect(() => {
    // Don't sync if we're intentionally closing the panel
    if (isClosingRef.current) {
      return;
    }

    const traceIdFromUrl = searchParams.get('id');
    if (traceIdFromUrl) {
      // Only update if different from current selection
      if (traceIdFromUrl !== selectedTraceId) {
        isClosingRef.current = false; // Reset closing flag when opening from URL
        setSelectedTraceId(traceIdFromUrl);
        setIsPanelOpen(true);
      }
    } else if (selectedTraceId && isPanelOpen) {
      // URL param was removed but panel is still open - close it
      setIsPanelOpen(false);
      setTimeout(() => setSelectedTraceId(null), 300);
    }
  }, [searchParams, selectedTraceId, isPanelOpen]);

  // Handle keyboard shortcut (Esc) to close sidebar
  useEffect(() => {
    if (!isPanelOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClosePanel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPanelOpen, handleClosePanel]);

  // Handle initial load
  useEffect(() => {
    if (!initialLoadComplete && data?.data && data.data.length > 0) {
      const requests = data.data;
      setMergedRequests(requests);
      latestTimestampRef.current = requests[0]!.Timestamp;
      setInitialLoadComplete(true);
    }
  }, [data, initialLoadComplete]);

  // Handle live mode updates
  useEffect(() => {
    if (!isLiveMode || !data?.data || !initialLoadComplete) {
      return;
    }

    if (data.data.length === 0) {
      // No new data, keep existing list
      return;
    }

    // Merge new requests with existing, deduplicating by TraceId + SpanId
    // Filter to only include records newer than our latest timestamp
    setMergedRequests((prev) => {
      const currentLatest = latestTimestampRef.current;

      if (!currentLatest) {
        // No previous timestamp, just use all data
        const requests = data.data;
        if (requests.length > 0) {
          latestTimestampRef.current = requests[0]!.Timestamp;
        }
        return requests;
      }

      // Filter to only new records
      const newRequests = data.data.filter((r) => r.Timestamp > currentLatest);

      if (newRequests.length === 0) {
        return prev;
      }

      // Get existing keys for deduplication
      const existingKeys = new Set(prev.map((r) => `${r.TraceId}-${r.SpanId}`));

      // Filter out duplicates
      const uniqueNewRequests = newRequests.filter(
        (r) => !existingKeys.has(`${r.TraceId}-${r.SpanId}`),
      );

      if (uniqueNewRequests.length === 0) {
        return prev;
      }

      // Prepend new requests and sort by timestamp DESC
      const merged = [...uniqueNewRequests, ...prev].sort((a, b) => b.Timestamp - a.Timestamp);

      // Update latest timestamp ref (not state, to avoid re-renders)
      if (merged.length > 0) {
        latestTimestampRef.current = merged[0]!.Timestamp;
      }

      // Limit to 100 most recent
      return merged.slice(0, 100);
    });
  }, [data, isLiveMode, initialLoadComplete]);

  // Reset when live mode is disabled
  useEffect(() => {
    if (!isLiveMode && initialLoadComplete && data?.data) {
      const requests = data.data;
      setMergedRequests(requests);
      if (requests.length > 0) {
        latestTimestampRef.current = requests[0]!.Timestamp;
      }
    }
  }, [isLiveMode, data, initialLoadComplete]);

  const requests = isLiveMode && initialLoadComplete ? mergedRequests : (data?.data ?? []);

  // Handle errors - stop live mode if error occurs
  useEffect(() => {
    if (error && isLiveMode) {
      setAutoStoppedLiveMode(true);
      setIsLiveMode(false);
    } else if (!error) {
      // Reset flag when error clears
      setAutoStoppedLiveMode(false);
    }
  }, [error, isLiveMode]);

  // Show loading only on initial load, not during live mode polling
  if (loading && !initialLoadComplete) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="text-gray-600">Loading requests...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">LLM Requests</h1>
          <p className="text-gray-600 mt-1">
            Root traces from your LLM requests. Click a row to view details in sidebar, or
            Cmd/Ctrl+click to open in a new tab.
          </p>
        </div>
        <button
          onClick={() => setIsLiveMode(!isLiveMode)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-colors ${
            isLiveMode
              ? 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'
              : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
          }`}
        >
          <div className="flex items-center gap-2">
            {isLiveMode && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
              </span>
            )}
            <span className="font-medium">{isLiveMode ? 'LIVE' : 'Live Mode'}</span>
          </div>
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-red-800 font-semibold mb-2">Error loading requests</h3>
              <p className="text-red-600 text-sm">{error.message}</p>
              {autoStoppedLiveMode && (
                <p className="text-red-600 text-sm mt-2">
                  Live mode has been stopped due to the error.
                </p>
              )}
            </div>
            <button
              onClick={() => void refetch()}
              className="ml-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {requests.length === 0 && !error ? (
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
