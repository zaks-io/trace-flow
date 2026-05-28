'use client';

import { AlertOctagon } from 'lucide-react';
import { formatNumber, formatPercent } from '@/lib/format';
import { AgentSection, AgentTableEmpty } from './AgentSection';
import type { FailureLeaderboardRow } from './types';

function failureAccent(rate: number | null): string {
  if (rate == null) return 'text-muted-foreground';
  if (rate >= 0.25) return 'text-red-400';
  if (rate >= 0.1) return 'text-amber-500';
  return 'text-emerald-500';
}

export function FailureLeaderboardTable({ data }: { data: FailureLeaderboardRow[] }) {
  return (
    <AgentSection
      icon={AlertOctagon}
      title="Failure leaderboard"
      subtitle="Tools ranked by failure rate. Unknown-status events are counted but excluded from the rate."
      count={data.length}
      countLabel="tools"
    >
      {data.length === 0 ? (
        <AgentTableEmpty message="No tool activity above the display floor for this range." />
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="pb-2 pl-3 font-medium">Tool</th>
                <th className="pb-2 font-medium">Command</th>
                <th className="pb-2 text-right font-medium">Events</th>
                <th className="pb-2 text-right font-medium">Failures</th>
                <th className="pb-2 text-right font-medium">Unknown</th>
                <th className="pb-2 pr-3 text-right font-medium">Failure rate</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr
                  key={`${row.tool_name}:${row.command_family}`}
                  className="border-b border-border/50 transition-colors hover:bg-muted/30"
                >
                  <td className="py-2.5 pl-3 font-medium text-foreground">{row.tool_name}</td>
                  <td className="py-2.5 text-muted-foreground">{row.command_family || '—'}</td>
                  <td className="py-2.5 text-right font-mono text-muted-foreground">
                    {formatNumber(row.event_count)}
                  </td>
                  <td className="py-2.5 text-right font-mono text-muted-foreground">
                    {formatNumber(row.failure_count)}
                  </td>
                  <td className="py-2.5 text-right font-mono text-muted-foreground">
                    {formatNumber(row.unknown_count)}
                  </td>
                  <td
                    className={`py-2.5 pr-3 text-right font-mono ${failureAccent(row.failure_rate)}`}
                  >
                    {row.failure_rate == null ? '—' : formatPercent(row.failure_rate * 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AgentSection>
  );
}
