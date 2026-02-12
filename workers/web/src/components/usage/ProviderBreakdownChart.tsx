'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { formatCurrency } from '@/lib/format';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { providerChartConfig } from './types';
import type { ProviderRow } from './types';

const PROVIDER_COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];

export function ProviderBreakdownChart({ data }: { data: ProviderRow[] }) {
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No provider data available</p>;
  }

  const barData = data.map((row, i) => ({
    ...row,
    fill: PROVIDER_COLORS[i % PROVIDER_COLORS.length],
  }));

  return (
    <ChartContainer
      config={providerChartConfig}
      className="!aspect-auto w-full"
      style={{ height: Math.max(data.length * 40, 120) }}
    >
      <BarChart data={barData} layout="vertical" margin={{ left: 80 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={(v: number) => formatCurrency(v)}
          tick={{ fontSize: 11 }}
        />
        <YAxis type="category" dataKey="provider" tick={{ fontSize: 12 }} width={75} />
        <ChartTooltip
          content={<ChartTooltipContent formatter={(value) => formatCurrency(Number(value))} />}
        />
        <Bar dataKey="total_cost_usd" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
