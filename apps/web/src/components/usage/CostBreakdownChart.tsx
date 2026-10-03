'use client';

import { PieChart, Pie } from 'recharts';
import { formatCurrency, formatPercent } from '@/lib/format';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { TOKEN_TYPES, TOKEN_TYPE_SERIES, type TokenType } from '@/components/shared/tokenTypes';
import { pieChartConfig } from './types';
import type { SummaryRow } from './types';

export function CostBreakdownChart({ summary }: { summary: SummaryRow }) {
  const costs: Record<TokenType, number> = {
    input: summary.input_cost_usd,
    cacheRead: summary.cache_read_cost_usd,
    cacheWrite: summary.cache_creation_cost_usd,
    output: summary.output_cost_usd,
    reasoning: summary.reasoning_cost_usd,
  };
  const entries = TOKEN_TYPES.map((type) => ({
    key: type,
    label: TOKEN_TYPE_SERIES[type].label,
    value: costs[type],
    color: TOKEN_TYPE_SERIES[type].color,
  })).filter((e) => e.value > 0);

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No cost data available</p>;
  }

  const total = entries.reduce((sum, e) => sum + e.value, 0);
  const pieData = entries.map((e) => ({
    name: e.key,
    value: e.value,
    fill: `var(--color-${e.key})`,
  }));

  return (
    <div className="flex items-center gap-6">
      <ChartContainer config={pieChartConfig} className="!aspect-auto h-48 w-48 shrink-0">
        <PieChart>
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius={45}
            outerRadius={75}
            paddingAngle={2}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent nameKey="name" valueFormatter={(v) => formatCurrency(v)} />
            }
          />
        </PieChart>
      </ChartContainer>
      <div className="space-y-2 text-sm">
        {entries.map((entry) => (
          <div key={entry.key} className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: entry.color }} />
            <span className="text-muted-foreground">{entry.label}</span>
            <span className="ml-auto font-mono text-foreground">{formatCurrency(entry.value)}</span>
            <span className="w-12 text-right font-mono text-muted-foreground">
              {formatPercent((entry.value / total) * 100)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
