'use client';

import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { formatCurrency, formatNumber } from '@/lib/format';
import { BentoCell } from './BentoCell';
import type { AgentReviewUnitCostRow } from './types';

export function ReviewUnitCostsCell({
  rows,
  labelFor,
}: {
  rows: AgentReviewUnitCostRow[];
  labelFor: (value: string) => string;
}) {
  const totalCost = rows.reduce((sum, row) => sum + row.estimated_cost_usd, 0);
  const totalSessions = rows.reduce((sum, row) => sum + row.session_count, 0);

  return (
    <BentoCell
      title="Review unit costs"
      hint="directly linked PRs and MRs"
      caveat="Direct links only. Ambiguous, cross-repo, and branch-only work stays at repo cost."
    >
      {rows.length === 0 ? (
        <div className="flex min-h-28 items-center text-sm text-muted-foreground">
          No directly linked review units in this range.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
            <div>
              <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                {formatCurrency(totalCost)}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatCount(rows.length, 'review unit')}, {formatCount(totalSessions, 'session')}
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border/60">
                  <Th>Review</Th>
                  <Th>Repo</Th>
                  <Th className="text-right">Cost</Th>
                  <Th className="text-right">Sessions</Th>
                  <Th className="text-right">Coverage</Th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 6).map((row) => (
                  <tr key={row.review_unit_key} className="border-b border-border/30 last:border-0">
                    <Td>
                      <a
                        href={row.review_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-[15rem] items-center gap-1 truncate text-foreground hover:text-primary"
                        title={row.review_url}
                      >
                        <span className="truncate">{reviewLabel(row)}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    </Td>
                    <Td
                      className="max-w-[12rem] truncate text-muted-foreground"
                      title={labelFor(row.repo_fingerprint)}
                    >
                      {labelFor(row.repo_fingerprint)}
                    </Td>
                    <Td className="text-right font-mono font-semibold tabular-nums text-foreground">
                      {formatCurrency(row.estimated_cost_usd)}
                    </Td>
                    <Td className="text-right font-mono tabular-nums text-muted-foreground">
                      {formatNumber(row.session_count)}
                    </Td>
                    <Td className="text-right font-mono tabular-nums text-muted-foreground">
                      {formatCoverage(row.coverage_pct)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </BentoCell>
  );
}

function reviewLabel(row: AgentReviewUnitCostRow): string {
  const kind = row.review_url.includes('/-/merge_requests/') ? 'MR' : 'PR';
  return `${row.review_host}/${row.review_owner}/${row.review_repo} ${kind} #${row.review_number}`;
}

function formatCoverage(value: number | null): string {
  if (value == null) return 'n/a';
  return `${Math.round(value * 100)}%`;
}

function formatCount(value: number, noun: string): string {
  return `${formatNumber(value)} ${noun}${value === 1 ? '' : 's'}`;
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th className={`py-1.5 font-medium ${className}`}>{children}</th>;
}

function Td({
  children,
  className = '',
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`py-2 align-middle ${className}`} title={title}>
      {children}
    </td>
  );
}
