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
  events: {
    name: string;
    offset: number;
    timestamp: number;
    attributes: string;
    row: number;
  }[];
  maxEventRow: number;
}
const getEventColor = (eventType: string): string => {
  const hash = eventType.split('').reduce((acc, char) => {
    return char.charCodeAt(0) + ((acc << 5) - acc);
  }, 0);

  const colors = [
    'bg-blue-500',
    'bg-green-500',
    'bg-purple-500',
    'bg-pink-500',
    'bg-orange-500',
    'bg-cyan-500',
    'bg-yellow-500',
    'bg-indigo-500',
    'bg-rose-500',
    'bg-teal-500',
  ];

  return colors[Math.abs(hash) % colors.length] ?? 'bg-gray-500';
};
export function SpanGanttChart({ spans }: SpanGanttChartProps) {
  const assignEventRows = (
    events: { name: string; offset: number; timestamp: number; attributes: string }[],
  ): {
    name: string;
    offset: number;
    timestamp: number;
    attributes: string;
    row: number;
  }[] => {
    if (events.length === 0) return [];

    const minSpacing = 1.5;
    const sortedEvents = [...events].sort((a, b) => a.offset - b.offset);
    const eventsWithRows: {
      name: string;
      offset: number;
      timestamp: number;
      attributes: string;
      row: number;
    }[] = [];

    for (const event of sortedEvents) {
      let assignedRow = 0;
      let rowOccupied = true;

      while (rowOccupied) {
        const conflictingEvent = eventsWithRows.find(
          (e) => e.row === assignedRow && Math.abs(e.offset - event.offset) < minSpacing,
        );

        if (!conflictingEvent) {
          rowOccupied = false;
        } else {
          assignedRow++;
        }
      }

      eventsWithRows.push({
        ...event,
        row: assignedRow,
      });
    }

    return eventsWithRows.reverse();
  };

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

        const rawEvents = (span['Events.Name'] ?? [])
          .map((name, idx) => {
            const eventTimestamp = span['Events.Timestamp']?.[idx];
            if (eventTimestamp === undefined) return null;
            const eventOffset = ((eventTimestamp - traceStartTime) / totalDuration) * 100;
            return {
              name,
              offset: eventOffset,
              timestamp: eventTimestamp,
              attributes: span['Events.Attributes']?.[idx] ?? '{}',
            };
          })
          .filter((event): event is NonNullable<typeof event> => event !== null);

        const events = assignEventRows(rawEvents);
        const maxEventRow = events.length > 0 ? Math.max(...events.map((e) => e.row)) : 0;

        rows.push({
          span,
          depth,
          startOffset,
          width: Math.max(width, 0.5),
          events,
          maxEventRow,
        });

        rows.push(...buildSpanTree(span.SpanId, depth + 1));
      }

      return rows;
    };

    const rootStartOffset = 0;
    const rootWidth = (rootSpan.Duration / totalDuration) * 100;

    const rawRootEvents = (rootSpan['Events.Name'] ?? [])
      .map((name, idx) => {
        const eventTimestamp = rootSpan['Events.Timestamp']?.[idx];
        if (eventTimestamp === undefined) return null;
        const eventOffset = ((eventTimestamp - traceStartTime) / totalDuration) * 100;
        return {
          name,
          offset: eventOffset,
          timestamp: eventTimestamp,
          attributes: rootSpan['Events.Attributes']?.[idx] ?? '{}',
        };
      })
      .filter((event): event is NonNullable<typeof event> => event !== null);

    const rootEvents = assignEventRows(rawRootEvents);
    const rootMaxEventRow = rootEvents.length > 0 ? Math.max(...rootEvents.map((e) => e.row)) : 0;

    return [
      {
        span: rootSpan,
        depth: 0,
        startOffset: rootStartOffset,
        width: Math.max(rootWidth, 0.5),
        events: rootEvents,
        maxEventRow: rootMaxEventRow,
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
            <div key={row.span.SpanId}>
              <div className="relative h-8 group" style={{ paddingLeft: `${row.depth * 24}px` }}>
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

              {row.events.length > 0 && (
                <div
                  className="relative flex items-center"
                  style={{
                    paddingLeft: `${row.depth * 24}px`,
                    height: `${(row.maxEventRow + 1) * 16}px`,
                  }}
                >
                  <div className="absolute inset-0">
                    <div className="flex-1 relative h-full">
                      {row.events.map((event, idx) => (
                        <div
                          key={idx}
                          className="absolute group/event -translate-x-1/2"
                          style={{
                            left: `${event.offset}%`,
                            top: `${event.row * 16}px`,
                          }}
                        >
                          <div
                            className={`w-3 h-3 rounded-full ${getEventColor(event.name)} border-2 border-white cursor-pointer hover:scale-150 transition-transform shadow-sm`}
                            title={event.name}
                          />
                          <div className="absolute left-1/2 -translate-x-1/2 top-5 opacity-0 group-hover/event:opacity-100 transition-opacity pointer-events-none z-20">
                            <div className="bg-gray-900 text-white text-xs px-2 py-1 rounded shadow-lg whitespace-nowrap min-w-max">
                              <div className="font-medium">{event.name}</div>
                              {event.attributes !== '{}' && (
                                <pre className="text-gray-300 text-xs mt-1 max-w-xs overflow-x-auto">
                                  {JSON.stringify(JSON.parse(event.attributes), null, 2)}
                                </pre>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
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
