import { AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TriggeredAlert, AlertSeverity, AlertField } from '@/types/alerts';
import { ALERT_OPERATOR_LABELS } from '@/types/alerts';
import { formatAlertValue } from '@/lib/alerts';

interface AlertListProps {
  triggeredAlerts: TriggeredAlert[];
  compact?: boolean;
}

const severityConfig: Record<
  AlertSeverity,
  {
    icon: React.ElementType;
    bg: string;
    border: string;
    text: string;
    edgeColor: string;
  }
> = {
  info: {
    icon: Info,
    bg: 'bg-blue-500/5',
    border: 'border-blue-500/20',
    text: 'text-blue-400',
    edgeColor: 'bg-blue-500',
  },
  warning: {
    icon: AlertTriangle,
    bg: 'bg-amber-500/5',
    border: 'border-amber-500/20',
    text: 'text-amber-400',
    edgeColor: 'bg-amber-500',
  },
  error: {
    icon: AlertCircle,
    bg: 'bg-red-500/5',
    border: 'border-red-500/20',
    text: 'text-red-400',
    edgeColor: 'bg-red-500',
  },
};

export function AlertList({ triggeredAlerts, compact = false }: AlertListProps) {
  if (triggeredAlerts.length === 0) return null;

  const sortedAlerts = [...triggeredAlerts].sort((a, b) => {
    const order = { error: 2, warning: 1, info: 0 };
    return order[b.alert.severity as AlertSeverity] - order[a.alert.severity as AlertSeverity];
  });

  if (compact) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {sortedAlerts.map((ta, idx) => {
          const config = severityConfig[ta.alert.severity as AlertSeverity];
          const Icon = config.icon;
          return (
            <span
              key={idx}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                config.bg,
                config.border,
                config.text,
              )}
            >
              <Icon className="h-3 w-3" />
              {ta.alert.name}
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sortedAlerts.map((ta, idx) => {
        const config = severityConfig[ta.alert.severity as AlertSeverity];
        const Icon = config.icon;
        const operatorLabel =
          ALERT_OPERATOR_LABELS[ta.alert.operator as keyof typeof ALERT_OPERATOR_LABELS];
        return (
          <div
            key={idx}
            className={cn(
              'group relative overflow-hidden rounded-lg border transition-colors hover:bg-muted/30',
              config.bg,
              config.border,
            )}
          >
            <div className={cn('absolute left-0 top-0 h-full w-1', config.edgeColor)} />
            <div className="flex items-start gap-3 py-3 pl-4 pr-3">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', config.text)} />
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm font-medium', config.text)}>{ta.alert.name}</p>
                <div className="mt-1 flex items-baseline gap-2 text-xs text-muted-foreground">
                  <span className="font-mono tabular-nums">
                    {formatAlertValue(ta.actualValue, ta.alert.field as AlertField)}
                  </span>
                  <span className="opacity-40">·</span>
                  <span>
                    threshold {operatorLabel}{' '}
                    <span className="font-mono tabular-nums">
                      {formatAlertValue(ta.alert.value, ta.alert.field as AlertField)}
                    </span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
