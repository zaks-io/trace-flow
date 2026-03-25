'use client';

import { TrendingUp, TrendingDown, Minus, AlertTriangle } from 'lucide-react';
import { formatCurrency, formatPercent } from '@/lib/format';
import type { CostForecastRow } from './types';

const trendConfig = {
  up: { icon: TrendingUp, color: 'text-red-400' },
  down: { icon: TrendingDown, color: 'text-emerald-400' },
  stable: { icon: Minus, color: 'text-muted-foreground' },
} as const;

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
export function ProjectedCostCard({ forecast }: { forecast: CostForecastRow | null }) {
  const currentMonthLabel = SHORT_MONTHS[new Date().getUTCMonth()];
  if (!forecast || forecast.insufficient_data) {
    return (
      <div className="relative min-w-0 overflow-hidden rounded-xl bg-linear-to-br from-chart-6/20 to-chart-6/5 p-5">
        <p className="text-xs font-medium tracking-wide text-muted-foreground">
          {currentMonthLabel} Projection
        </p>
        <p className="mt-2 font-mono text-3xl font-medium tabular-nums text-foreground">-</p>
        <p className="mt-1 text-xs text-muted-foreground">Not enough data</p>
      </div>
    );
  }

  const trend = (forecast.trend as keyof typeof trendConfig) ?? 'stable';
  const { icon: TrendIcon, color: trendColor } = trendConfig[trend] ?? trendConfig.stable;

  const mtdProgress =
    forecast.projected_monthly_cost > 0
      ? Math.min(100, (forecast.month_to_date_cost / forecast.projected_monthly_cost) * 100)
      : 0;

  return (
    <div className="relative min-w-0 overflow-hidden rounded-xl bg-linear-to-br from-chart-6/20 to-chart-6/5 p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground">
            {currentMonthLabel} Projection
          </p>
          <p className="mt-2 font-mono text-3xl font-medium tabular-nums text-foreground">
            {formatCurrency(forecast.projected_monthly_cost)}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {forecast.anomaly_count > 0 && (
            <span
              title={`${forecast.anomaly_count} anomalous day${forecast.anomaly_count > 1 ? 's' : ''} detected`}
            >
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
            </span>
          )}
          <div className={`flex items-center gap-1 text-xs font-medium ${trendColor}`}>
            <TrendIcon className="h-3 w-3" />
            {trend !== 'stable' && (
              <span className="font-mono tabular-nums">
                {formatPercent(Math.abs(forecast.trend_percent))}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* MTD progress bar */}
      <div className="relative mt-3">
        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/30">
          <div
            className="h-full rounded-full bg-chart-6/70 transition-all"
            style={{ width: `${mtdProgress}%` }}
          />
        </div>
      </div>

      {/* Inline stats */}
      <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5">
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-chart-6/70" />
          <span className="font-mono tabular-nums">
            {formatCurrency(forecast.month_to_date_cost)}
          </span>
          <span>MTD</span>
        </span>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
          <span className="font-mono tabular-nums">
            {formatCurrency(forecast.confidence_low)}&ndash;
            {formatCurrency(forecast.confidence_high)}
          </span>
          <span>Range</span>
        </span>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
          <span className="font-mono tabular-nums">{formatCurrency(forecast.daily_average)}</span>
          <span>/day</span>
        </span>
      </div>
    </div>
  );
}
