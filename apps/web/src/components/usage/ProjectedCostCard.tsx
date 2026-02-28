import { TrendingUp, TrendingDown, Minus, AlertTriangle } from 'lucide-react';
import { formatCurrency, formatPercent } from '@/lib/format';
import type { CostForecastRow } from './types';

const trendConfig = {
  up: { icon: TrendingUp, color: 'text-red-400', label: 'up' },
  down: { icon: TrendingDown, color: 'text-emerald-400', label: 'down' },
  stable: { icon: Minus, color: 'text-muted-foreground', label: 'stable' },
} as const;

export function ProjectedCostCard({ forecast }: { forecast: CostForecastRow | null }) {
  if (!forecast || forecast.insufficient_data) {
    return (
      <div className="relative overflow-hidden rounded-xl bg-linear-to-br from-chart-6/20 to-chart-6/5 p-5">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground">
            Projected Monthly Cost
          </p>
          <p className="mt-2 font-mono text-3xl font-medium tabular-nums text-foreground">-</p>
          <p className="mt-1 text-xs text-muted-foreground">Not enough data</p>
        </div>
      </div>
    );
  }

  const trend = (forecast.trend as keyof typeof trendConfig) ?? 'stable';
  const { icon: TrendIcon, color: trendColor } = trendConfig[trend] ?? trendConfig.stable;

  return (
    <div className="relative overflow-hidden rounded-xl bg-linear-to-br from-chart-6/20 to-chart-6/5 p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground">
            Projected Monthly Cost
          </p>
          <p className="mt-2 font-mono text-3xl font-medium tabular-nums text-foreground">
            {formatCurrency(forecast.projected_monthly_cost)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatCurrency(forecast.confidence_low)} &ndash;{' '}
            {formatCurrency(forecast.confidence_high)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            {forecast.anomaly_count > 0 && (
              <span
                title={`${forecast.anomaly_count} anomalous day${forecast.anomaly_count > 1 ? 's' : ''} detected`}
              >
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
              </span>
            )}
            <div className={`flex items-center gap-1 text-xs font-medium ${trendColor}`}>
              <TrendIcon className="h-3.5 w-3.5" />
              {trend !== 'stable' && <span>{formatPercent(Math.abs(forecast.trend_percent))}</span>}
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            MTD: {formatCurrency(forecast.month_to_date_cost)}
          </p>
          <p className="text-[10px] text-muted-foreground">
            Based on {forecast.basis_days}d history
          </p>
        </div>
      </div>
    </div>
  );
}
