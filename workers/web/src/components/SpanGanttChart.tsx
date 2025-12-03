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
        return 'bg-emerald-500';
      case 'ERROR':
        return 'bg-red-500';
      default:
        return 'bg-zinc-500';
    }
  };

  if (spanRows.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
      <div className="space-y-0.5">
        {spanRows.map((row) => (
          <div
            key={row.span.SpanId}
            className="group relative h-2"
            style={{ paddingLeft: `${row.depth * 12}px` }}
          >
            <div className="absolute inset-0 flex items-center">
              <div className="relative h-full flex-1">
                <div
                  className={`absolute h-full rounded-sm transition-opacity hover:opacity-80 ${getStatusColor(row.span.StatusCode)}`}
                  style={{
                    left: `${row.startOffset}%`,
                    width: `${row.width}%`,
                    minWidth: '2px',
                  }}
                />
              </div>
            </div>

            <div className="pointer-events-none absolute -top-1 left-0 z-10 opacity-0 transition-opacity group-hover:opacity-100">
              <div
                className="whitespace-nowrap rounded bg-popover px-2 py-1 text-xs shadow-lg"
                style={{ marginLeft: `${row.depth * 12}px` }}
              >
                <span className="font-medium text-foreground">{row.span.SpanName}</span>
                <span className="mx-1.5 text-muted-foreground">·</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatDuration(row.span.Duration)}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 flex justify-between border-t border-border/30 pt-1.5 text-[10px] tabular-nums text-muted-foreground/70">
        <span>0</span>
        <span>
          {formatDuration(
            Math.max(...spans.map((s) => s.Timestamp + s.Duration)) -
              Math.min(...spans.map((s) => s.Timestamp)),
          )}
        </span>
      </div>
    </div>
  );
}
