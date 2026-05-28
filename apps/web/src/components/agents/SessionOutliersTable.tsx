'use client';

import { Flame } from 'lucide-react';
import { formatCurrency, formatNumber } from '@/lib/format';
import { AgentSection, AgentTableEmpty } from './AgentSection';
import type { SessionOutlierRow } from './types';

/** A repo_fingerprint is a hash; show a short, stable prefix. Empty = no repo. */
function repoLabel(fingerprint: string): string {
  if (!fingerprint) return 'No repo';
  return fingerprint.slice(0, 10);
}

export function SessionOutliersTable({ data }: { data: SessionOutlierRow[] }) {
  return (
    <AgentSection
      icon={Flame}
      title="Session outliers"
      subtitle="Highest estimated-cost sessions, then by files touched. Cost is estimated, not billed."
      count={data.length}
      countLabel="sessions"
    >
      {data.length === 0 ? (
        <AgentTableEmpty message="No agent sessions for this range." />
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="pb-2 pl-3 font-medium">Session</th>
                <th className="pb-2 font-medium">Source</th>
                <th className="pb-2 font-medium">Repo</th>
                <th className="pb-2 text-right font-medium">Messages</th>
                <th className="pb-2 text-right font-medium">File events</th>
                <th className="pb-2 text-right font-medium">Files</th>
                <th className="pb-2 pr-3 text-right font-medium">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr
                  key={row.session_pk}
                  className="border-b border-border/50 transition-colors hover:bg-muted/30"
                >
                  <td className="py-2.5 pl-3 font-mono text-xs text-muted-foreground">
                    {row.session_pk.slice(0, 12)}
                  </td>
                  <td className="py-2.5 text-foreground">{row.source}</td>
                  <td className="py-2.5 font-mono text-xs text-muted-foreground">
                    {repoLabel(row.repo_fingerprint)}
                  </td>
                  <td className="py-2.5 text-right font-mono text-muted-foreground">
                    {formatNumber(row.message_count)}
                  </td>
                  <td className="py-2.5 text-right font-mono text-muted-foreground">
                    {formatNumber(row.file_event_count)}
                  </td>
                  <td className="py-2.5 text-right font-mono text-muted-foreground">
                    {formatNumber(row.unique_file_count)}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono text-foreground">
                    {formatCurrency(row.cost_usd)}
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
