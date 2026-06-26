import { cn } from '@/lib/utils';

export type Metric = {
  label: string;
  value: string;
  tone?: 'default' | 'danger';
};

/** A compact row of labeled metric chips — the rich alternative to dumping a JSON summary. */
export function MetricChips({ metrics, className }: { metrics: Metric[]; className?: string }) {
  if (metrics.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {metrics.map((metric) => (
        <span
          key={metric.label}
          className={cn(
            'inline-flex items-baseline gap-1 rounded-md border px-1.5 py-0.5',
            metric.tone === 'danger'
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-border/60 bg-muted/40 text-foreground',
          )}
        >
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {metric.label}
          </span>
          <span className="font-mono text-[11px] tabular-nums">{metric.value}</span>
        </span>
      ))}
    </div>
  );
}
