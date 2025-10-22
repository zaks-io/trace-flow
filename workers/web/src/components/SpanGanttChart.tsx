'use client';

import { useMemo } from 'react';
import type { TraceSpan } from './TraceDetailContent';

interface SpanGanttChartProps {
  spans: TraceSpan[];
}

interface SpanRow {
  span: TraceSpan;
  depth: number;
  startOffset: number;
  width: number;
}

export function SpanGanttChart({ spans }: SpanGanttChartProps) {
  const spanRows = useMemo(() => {
    if (spans.length === 0) return [];

    const rootSpan = spans.find((s) => s.ParentSpanId === '');
    if (!rootSpan) return [];

    const traceStartTime = rootSpan.Timestamp;
    const traceEndTime = Math.max(...spans.map((s) => s.Timestamp + s.Duration));
    const totalDuration = traceEndTime - traceStartTime;

    const buildSpanTree = (parentId: string, depth = 0): SpanRow[] => {
      const children = spans
        .filter((s) => s.ParentSpanId === parentId)
        .sort((a, b) => a.Timestamp - b.Timestamp);

      const rows: SpanRow[] = [];

      for (const span of children) {
        const startOffset = ((span.Timestamp - traceStartTime) / totalDuration) * 100;
        const width = (span.Duration / totalDuration) * 100;

        rows.push({
          span,
          depth,
          startOffset,
          width: Math.max(width, 0.5),
        });

        rows.push(...buildSpanTree(span.SpanId, depth + 1));
      }

      return rows;
    };

    const rootStartOffset = 0;
    const rootWidth = (rootSpan.Duration / totalDuration) * 100;

    return [
      {
        span: rootSpan,
        depth: 0,
        startOffset: rootStartOffset,
        width: Math.max(rootWidth, 0.5),
      },
      ...buildSpanTree(rootSpan.SpanId, 1),
    ];
  }, [spans]);

  const formatDuration = (nanoseconds: number) => {
    const milliseconds = nanoseconds / 1_000_000;
    if (milliseconds < 1) {
      return `${(milliseconds * 1000).toFixed(0)}μs`;
    }
    if (milliseconds < 1000) {
      return `${milliseconds.toFixed(2)}ms`;
    }
    return `${(milliseconds / 1000).toFixed(2)}s`;
  };

  const getStatusColor = (statusCode: string) => {
    switch (statusCode) {
      case 'OK':
        return 'bg-green-500';
      case 'ERROR':
        return 'bg-red-500';
      default:
        return 'bg-gray-400';
    }
  };

  const getStatusBorderColor = (statusCode: string) => {
    switch (statusCode) {
      case 'OK':
        return 'border-green-600';
      case 'ERROR':
        return 'border-red-600';
      default:
        return 'border-gray-500';
    }
  };

  if (spanRows.length === 0) {
    return <div className="text-sm text-gray-500 text-center py-8">No spans to display</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-xs text-gray-600">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-green-500 rounded"></div>
          <span>OK</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-red-500 rounded"></div>
          <span>ERROR</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-gray-400 rounded"></div>
          <span>UNSET</span>
        </div>
      </div>

      <div className="relative bg-gray-50 rounded-lg p-4">
        <div className="space-y-1">
          {spanRows.map((row) => (
            <div
              key={row.span.SpanId}
              className="relative h-8 group"
              style={{ paddingLeft: `${row.depth * 24}px` }}
            >
              <div className="absolute inset-0 flex items-center">
                <div className="flex-1 relative h-6">
                  <div
                    className={`absolute h-full rounded border ${getStatusColor(row.span.StatusCode)} ${getStatusBorderColor(row.span.StatusCode)} transition-all cursor-pointer hover:opacity-80`}
                    style={{
                      left: `${row.startOffset}%`,
                      width: `${row.width}%`,
                    }}
                    title={`${row.span.SpanName} - ${formatDuration(row.span.Duration)}`}
                  >
                    <div className="absolute inset-0 flex items-center px-2 text-xs text-white font-medium truncate">
                      {row.width > 5 ? row.span.SpanName : ''}
                    </div>
                  </div>
                </div>
              </div>

              <div className="absolute left-0 top-0 bottom-0 flex items-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                <div className="bg-gray-900 text-white text-xs px-2 py-1 rounded shadow-lg whitespace-nowrap z-10">
                  <div className="font-medium">{row.span.SpanName}</div>
                  <div className="text-gray-300">{formatDuration(row.span.Duration)}</div>
                  <div className="text-gray-400">{row.span.ServiceName}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-between text-xs text-gray-500 mt-4 pt-2 border-t">
          <span>0ms</span>
          <span>Timeline</span>
          <span>
            {formatDuration(
              Math.max(...spans.map((s) => s.Timestamp + s.Duration)) -
                Math.min(...spans.map((s) => s.Timestamp)),
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
