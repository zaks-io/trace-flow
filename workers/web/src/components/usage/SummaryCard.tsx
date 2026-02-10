import type { SummaryCardProps } from './types';

const accentColors = {
  purple: 'from-purple-500/20 to-purple-500/5 border-purple-500/30',
  blue: 'from-blue-500/20 to-blue-500/5 border-blue-500/30',
  emerald: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30',
  amber: 'from-amber-500/20 to-amber-500/5 border-amber-500/30',
};

const iconColors = {
  purple: 'text-purple-400',
  blue: 'text-blue-400',
  emerald: 'text-emerald-400',
  amber: 'text-amber-400',
};

export function SummaryCard({ icon, label, value, subtitle, accent = 'purple' }: SummaryCardProps) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border bg-linear-to-br p-4 ${accentColors[accent]}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
            {value}
          </p>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        <div className={`rounded-lg bg-background/50 p-2 ${iconColors[accent]}`}>{icon}</div>
      </div>
    </div>
  );
}
