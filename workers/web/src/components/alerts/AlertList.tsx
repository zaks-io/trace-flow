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
  }
> = {
  info: {
    icon: Info,
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/30',
    text: 'text-blue-400',
  },
  warning: {
    icon: AlertTriangle,
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    text: 'text-amber-400',
  },
  error: {
    icon: AlertCircle,
    bg: 'bg-red-500/10',
    border: 'border-red-500/30',
    text: 'text-red-400',
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
            className={cn('flex items-start gap-3 rounded-lg border p-3', config.bg, config.border)}
          >
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', config.text)} />
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm font-medium', config.text)}>{ta.alert.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Value:{' '}
                <span className="font-mono">
                  {formatAlertValue(ta.actualValue, ta.alert.field as AlertField)}
                </span>{' '}
                (threshold: {operatorLabel}{' '}
                {formatAlertValue(ta.alert.value, ta.alert.field as AlertField)})
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
