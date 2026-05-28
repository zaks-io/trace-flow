'use client';

import { useEffect, useMemo, useState } from 'react';
import { Table2, ChevronDown } from 'lucide-react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { formatCurrency, formatNumber, formatDuration } from '@/lib/format';
import type { TinybirdResponse } from '@/components/usage/types';
import { AgentSection, AgentTableEmpty } from './AgentSection';
import { AGENT_SESSION_PAGE_SIZE, type AgentSessionRow, type AgentSessionSort } from './types';

const SORT_COLUMNS: { key: AgentSessionSort; label: string }[] = [
  { key: 'messages', label: 'Messages' },
  { key: 'files', label: 'File events' },
  { key: 'duration', label: 'Duration' },
  { key: 'cost', label: 'Est. cost' },
];

function formatLastEvent(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function repoName(fingerprint: string, repoLabelMap: Map<string, string>): string {
  if (!fingerprint) return 'No repo';
  return repoLabelMap.get(fingerprint) ?? fingerprint.slice(0, 10);
}

/**
 * Browsable Agent Session drill-down: sortable, paginated, honoring the active filters.
 * Owns its sort + page state and fetches the agent_sessions_browser pipe directly so it
 * loads independently of the hero surfaces. Sort-by-cost reproduces the prior outliers.
 */
export function AgentSessionsTable({
  filterParams,
  repoLabelMap,
}: {
  filterParams: Record<string, string | number>;
  repoLabelMap: Map<string, string>;
}) {
  const [sort, setSort] = useState<AgentSessionSort>('cost');
  const [page, setPage] = useState(0);

  // Reset to the first page when the filters or sort change, so a narrowed result set can't
  // leave the offset past the end (which would show a false empty state with no pager).
  useEffect(() => setPage(0), [filterParams, sort]);

  const params = useMemo(
    () => ({
      ...filterParams,
      sort,
      limit: AGENT_SESSION_PAGE_SIZE,
      offset: page * AGENT_SESSION_PAGE_SIZE,
    }),
    [filterParams, sort, page],
  );

  const query = useTinybirdQuery<TinybirdResponse<AgentSessionRow>>({
    pipe: 'agent_sessions_browser',
    params,
  });
  const rows = useMemo(() => query.data?.data ?? [], [query.data]);

  const selectSort = (key: AgentSessionSort) => {
    setSort(key);
    setPage(0);
  };

  // A full page implies there may be more; the offset pager needs no total count.
  const hasNextPage = rows.length === AGENT_SESSION_PAGE_SIZE;

  return (
    <AgentSection
      icon={Table2}
      title="Agent sessions"
      subtitle="Browse sessions; sort by cost, files, duration, or messages. Cost is estimated, not billed."
      count={rows.length}
      countLabel="sessions"
    >
      {rows.length === 0 ? (
        <AgentTableEmpty message="No agent sessions for this range." />
      ) : (
        <>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 pl-3 font-medium">Session</th>
                  <th className="pb-2 font-medium">Source</th>
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium">Repo</th>
                  {SORT_COLUMNS.map((col) => (
                    <th key={col.key} className="pb-2 text-right font-medium">
                      <button
                        type="button"
                        onClick={() => selectSort(col.key)}
                        className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${
                          sort === col.key ? 'text-primary' : ''
                        }`}
                      >
                        {col.label}
                        {sort === col.key && <ChevronDown className="h-3 w-3" />}
                      </button>
                    </th>
                  ))}
                  <th className="pb-2 pr-3 text-right font-medium">Last event</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.session_pk}
                    className="border-b border-border/50 transition-colors hover:bg-muted/30"
                  >
                    <td className="py-2.5 pl-3 font-mono text-xs text-muted-foreground">
                      {row.session_pk.slice(0, 12)}
                    </td>
                    <td className="py-2.5 text-foreground">{row.source}</td>
                    <td className="py-2.5 text-muted-foreground">{row.model || '—'}</td>
                    <td className="py-2.5 text-xs text-muted-foreground">
                      {repoName(row.repo_fingerprint, repoLabelMap)}
                    </td>
                    <td className="py-2.5 text-right font-mono text-muted-foreground">
                      {formatNumber(row.message_count)}
                    </td>
                    <td className="py-2.5 text-right font-mono text-muted-foreground">
                      {formatNumber(row.file_event_count)}
                    </td>
                    <td className="py-2.5 text-right font-mono text-muted-foreground">
                      {formatDuration(row.duration_ms)}
                    </td>
                    <td className="py-2.5 text-right font-mono text-foreground">
                      {formatCurrency(row.cost_usd)}
                    </td>
                    <td className="py-2.5 pr-3 text-right text-xs text-muted-foreground">
                      {formatLastEvent(row.last_event_ms)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(page > 0 || hasNextPage) && (
            <div className="mt-4 flex items-center justify-end gap-2 text-xs">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded-lg border border-border px-2.5 py-1 font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-muted-foreground">Page {page + 1}</span>
              <button
                type="button"
                disabled={!hasNextPage}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg border border-border px-2.5 py-1 font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </AgentSection>
  );
}
