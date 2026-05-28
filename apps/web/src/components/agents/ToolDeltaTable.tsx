'use client';

import { TrendingUp } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import { AgentSection, AgentTableEmpty } from './AgentSection';
import type { ToolDeltaRow } from './types';

function DeltaCell({ value, invert = false }: { value: number; invert?: boolean }) {
  const positiveIsGood = !invert;
  const good = 'text-emerald-500';
  const bad = 'text-red-400';
  const accent = value === 0 ? 'text-muted-foreground' : value > 0 === positiveIsGood ? good : bad;
  const sign = value > 0 ? '+' : '';
  return (
    <td className={`py-2.5 text-right font-mono ${accent}`}>
      {sign}
      {formatNumber(value)}
    </td>
  );
}

export function ToolDeltaTable({ data }: { data: ToolDeltaRow[] }) {
  return (
    <AgentSection
      icon={TrendingUp}
      title="Period-over-period delta"
      subtitle="Tool usage and failures this period vs the prior equal-length window."
      count={data.length}
      countLabel="tools"
    >
      {data.length === 0 ? (
        <AgentTableEmpty message="No tool activity to compare across periods for this range." />
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="pb-2 pl-3 font-medium">Tool</th>
                <th className="pb-2 font-medium">Command</th>
                <th className="pb-2 text-right font-medium">Current</th>
                <th className="pb-2 text-right font-medium">Prior</th>
                <th className="pb-2 text-right font-medium">Δ Uses</th>
                <th className="pb-2 pr-3 text-right font-medium">Δ Failures</th>
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
                    {formatNumber(row.current_count)}
                  </td>
                  <td className="py-2.5 text-right font-mono text-muted-foreground">
                    {formatNumber(row.prior_count)}
                  </td>
                  <DeltaCell value={row.count_delta} />
                  <DeltaCell value={row.failure_delta} invert />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AgentSection>
  );
}
