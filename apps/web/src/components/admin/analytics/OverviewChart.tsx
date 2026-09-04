import { Line, LineChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { cn } from '@/lib/utils';
import { CHART_METRIC_COLORS, chartConfig } from './constants';
import { formatCompactNumber, formatDuration, formatInteger, formatPercentage } from './format';
import type { ChartMetric, TimeseriesRow } from './types';

export function OverviewChart({
  rows,
  metric,
  onMetricChange,
}: {
  rows: TimeseriesRow[];
  metric: ChartMetric;
  onMetricChange: (value: ChartMetric) => void;
}) {
  const formatter =
    metric === 'requestCount'
      ? formatInteger
      : metric === 'p95LatencyMs'
        ? formatDuration
        : metric === 'serverErrorRate'
          ? formatPercentage
          : formatCompactNumber;

  return (
    <Card className="bg-card/40">
      <CardHeader className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Time Series</CardTitle>
            <CardDescription>
              Weighted aggregates from the proxy Analytics Engine dataset.
            </CardDescription>
          </div>
          <div className="flex gap-1 rounded-lg border border-border bg-background p-1">
            {(
              ['requestCount', 'p95LatencyMs', 'serverErrorRate', 'totalTokens'] as ChartMetric[]
            ).map((value) => (
              <button
                key={value}
                onClick={() => onMetricChange(value)}
                className={cn(
                  'relative rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  metric === value
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                style={
                  metric === value
                    ? { borderBottom: `2px solid ${CHART_METRIC_COLORS[value]}` }
                    : undefined
                }
              >
                {chartConfig[value].label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[320px] w-full">
          <LineChart data={rows}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="bucket"
              tickLine={false}
              axisLine={false}
              minTickGap={24}
              tickFormatter={(value) => String(value).slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={80}
              tickFormatter={(value) => formatter(Number(value))}
            />
            <ChartTooltip
              content={<ChartTooltipContent valueFormatter={(value) => formatter(Number(value))} />}
            />
            <Line
              type="monotone"
              dataKey={metric}
              stroke={`var(--color-${metric})`}
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
