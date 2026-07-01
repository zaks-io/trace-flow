'use client';

import { useMemo, useState } from 'react';
import { formatCurrency, formatDuration, formatNumber } from '@/lib/format';
import type { AgentSessionRow } from './types';

export const SESSION_TABLE_PAGE_SIZE = 10;

/**
 * The drill-down behind "Where spend concentrates": the actual priciest conversations. A repo +
 * model rollup strip answers "what's driving the bulge", then a ranked list shows each costly
 * conversation as raw facts (cost, model, repo, messages, files, duration) — no bins, no
 * aggregation beyond the two rollups. Repos resolve to a name via `labelFor`; unmapped
 * fingerprints fall back to a short hash, which is expected for the ~half that don't map yet.
 */
export function SpendConcentrationDetail({
  sessions,
  loading,
  labelFor,
}: {
  sessions: AgentSessionRow[];
  loading: boolean;
  labelFor: (value: string) => string;
}) {
  const [page, setPage] = useState(0);
  const totalCost = useMemo(() => sessions.reduce((sum, s) => sum + s.cost_usd, 0), [sessions]);
  const byRepo = useMemo(
    () => rollup(sessions, (s) => repoLabel(s.repo_fingerprint, labelFor)),
    [sessions, labelFor],
  );
  const byModel = useMemo(() => rollup(sessions, (s) => s.model || 'unknown'), [sessions]);
  const pagination = paginateAgentSessions(sessions, page);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        Loading the priciest conversations…
      </div>
    );
  }

  if (sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">No conversations to show in this range.</p>;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <RollupStrip title="By repo" rows={byRepo} totalCost={totalCost} />
        <RollupStrip title="By model" rows={byModel} totalCost={totalCost} />
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            Priciest {formatNumber(sessions.length)} conversations
          </p>
          <div
            aria-label="Agent session pagination"
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <span>
              {formatNumber(pagination.start + 1)}-{formatNumber(pagination.end)} of{' '}
              {formatNumber(sessions.length)}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={pagination.pageIndex === 0}
              className="rounded-md border border-border/60 px-2 py-1 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pagination.pageCount - 1, p + 1))}
              disabled={pagination.pageIndex >= pagination.pageCount - 1}
              className="rounded-md border border-border/60 px-2 py-1 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/60">
                <Th className="text-right">Cost</Th>
                <Th>Repo</Th>
                <Th>Model</Th>
                <Th className="text-right">Msgs</Th>
                <Th className="text-right">Files</Th>
                <Th className="text-right">Duration</Th>
              </tr>
            </thead>
            <tbody>
              {pagination.rows.map((s) => (
                <tr key={s.session_pk} className="border-b border-border/30 last:border-0">
                  <Td className="text-right font-mono font-semibold tabular-nums text-foreground">
                    {formatCurrency(s.cost_usd)}
                  </Td>
                  <Td
                    className="max-w-[14rem] truncate text-foreground"
                    title={repoLabel(s.repo_fingerprint, labelFor)}
                  >
                    {repoLabel(s.repo_fingerprint, labelFor)}
                  </Td>
                  <Td className="text-muted-foreground">{s.model || 'unknown'}</Td>
                  <Td className="text-right font-mono tabular-nums text-muted-foreground">
                    {formatNumber(s.message_count)}
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-muted-foreground">
                    {formatNumber(s.unique_file_count)}
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-muted-foreground">
                    {formatDuration(s.duration_ms)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function paginateAgentSessions(
  sessions: readonly AgentSessionRow[],
  pageIndex: number,
  pageSize = SESSION_TABLE_PAGE_SIZE,
) {
  const pageCount = Math.max(1, Math.ceil(sessions.length / pageSize));
  const safePageIndex = Math.min(Math.max(0, pageIndex), pageCount - 1);
  const start = safePageIndex * pageSize;
  const end = Math.min(start + pageSize, sessions.length);

  return {
    rows: sessions.slice(start, end),
    pageIndex: safePageIndex,
    pageCount,
    start,
    end,
  };
}

interface RollupRow {
  key: string;
  cost: number;
  count: number;
}

/** Group sessions by a key, sum cost, count, and sort by spend desc. */
function rollup(sessions: AgentSessionRow[], keyOf: (s: AgentSessionRow) => string): RollupRow[] {
  const map = new Map<string, RollupRow>();
  for (const s of sessions) {
    const key = keyOf(s);
    const existing = map.get(key);
    if (existing) {
      existing.cost += s.cost_usd;
      existing.count += 1;
    } else {
      map.set(key, { key, cost: s.cost_usd, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

function RollupStrip({
  title,
  rows,
  totalCost,
}: {
  title: string;
  rows: RollupRow[];
  totalCost: number;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">{title}</p>
      <div className="flex flex-col gap-1.5">
        {rows.slice(0, 6).map((row) => {
          const share = totalCost > 0 ? row.cost / totalCost : 0;
          return (
            <div key={row.key} className="flex items-center gap-2">
              <div className="relative h-6 min-w-0 flex-1 overflow-hidden rounded-md bg-muted/30">
                <div
                  className="absolute inset-y-0 left-0 rounded-md"
                  style={{
                    width: `${Math.max(2, share * 100)}%`,
                    backgroundColor: 'color-mix(in oklch, var(--color-chart-1) 25%, transparent)',
                  }}
                />
                <span
                  className="absolute inset-y-0 left-2 flex items-center truncate text-[11px] text-foreground"
                  title={row.key}
                >
                  {row.key}
                </span>
              </div>
              <span className="w-16 shrink-0 text-right font-mono text-[11px] font-semibold tabular-nums text-foreground">
                {formatCurrency(row.cost)}
              </span>
              <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                {formatNumber(row.count)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Resolve a repo fingerprint to a display name; fall back to a short hash when unmapped. */
function repoLabel(fingerprint: string, labelFor: (value: string) => string): string {
  if (!fingerprint) return 'no repo';
  const resolved = labelFor(fingerprint);
  if (resolved && resolved !== fingerprint) return resolved;
  return fingerprint.length > 10 ? `${fingerprint.slice(0, 10)}…` : fingerprint;
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-2 py-1.5 font-medium ${className ?? ''}`}>{children}</th>;
}

function Td({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-2 py-1.5 ${className ?? ''}`} title={title}>
      {children}
    </td>
  );
}
