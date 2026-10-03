'use client';

import { UserRound } from 'lucide-react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import type { AccountDrilldownFilters } from '@/lib/upstreamAccount';
import type { UpstreamAccountRow } from './types';
import { UpstreamAccountTable } from './UpstreamAccountTable';

/** Hidden until local proxy executions exist, so organizations without CLIProxyAPI see no change. */
export function UpstreamAccountSection({
  params,
  drilldownFilters,
}: {
  params: Record<string, string | number>;
  drilldownFilters: AccountDrilldownFilters;
}) {
  const { data, error } = useTinybirdQuery<UpstreamAccountRow>({
    pipe: 'llm_usage_by_account',
    params,
  });
  const rows = data?.data ?? [];
  if (!error && rows.length === 0) return null;

  return (
    <div className="rounded-xl bg-card/40 p-6">
      <div className="mb-1 flex items-center gap-2">
        <UserRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-medium text-foreground">By Upstream Account</h2>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Local proxy executions, reported separately from agent sessions.
      </p>
      {error ? (
        <p className="text-sm text-destructive">Upstream account usage failed to load.</p>
      ) : (
        <UpstreamAccountTable data={rows} filters={drilldownFilters} />
      )}
    </div>
  );
}
