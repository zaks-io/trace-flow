import type { SummaryCardProps } from './types';

const accentColors = {
  purple: 'from-chart-5/20 to-chart-5/5',
  blue: 'from-chart-4/20 to-chart-4/5',
  emerald: 'from-chart-3/20 to-chart-3/5',
  amber: 'from-chart-2/20 to-chart-2/5',
  zinc: 'from-muted to-muted/50',
  red: 'from-chart-6/20 to-chart-6/5',
  green: 'from-chart-7/20 to-chart-7/5',
};

const iconColors = {
  purple: 'text-chart-5',
  blue: 'text-chart-4',
  emerald: 'text-chart-3',
  amber: 'text-chart-2',
  zinc: 'text-muted-foreground',
  red: 'text-chart-6',
  green: 'text-chart-7',
};

export function SummaryCard({ icon, label, value, subtitle, accent = 'purple' }: SummaryCardProps) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-linear-to-br p-5 ${accentColors[accent]}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-2 font-mono text-3xl font-medium tabular-nums text-foreground">
            {value}
          </p>
          {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        <div className={`p-2 ${iconColors[accent]}`}>{icon}</div>
      </div>
    </div>
  );
}
