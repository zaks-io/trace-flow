import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertBadge } from './AlertBadge';
import type { TriggeredAlert, AlertSeverity, AlertField } from '@/types/alerts';
import { ALERT_OPERATOR_LABELS } from '@/types/alerts';
import { getHighestSeverity, formatAlertValue } from '@/lib/alerts';

interface AlertIndicatorProps {
  triggeredAlerts: TriggeredAlert[];
}

export function AlertIndicator({ triggeredAlerts }: AlertIndicatorProps) {
  if (triggeredAlerts.length === 0) return null;

  const severities = triggeredAlerts.map((t) => t.alert.severity as AlertSeverity);
  const highestSeverity = getHighestSeverity(severities);

  if (!highestSeverity) return null;

  const sortedAlerts = [...triggeredAlerts].sort((a, b) => {
    const order = { error: 2, warning: 1, info: 0 };
    return order[b.alert.severity as AlertSeverity] - order[a.alert.severity as AlertSeverity];
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-pointer">
          <AlertBadge
            severity={highestSeverity}
            count={triggeredAlerts.length}
            variant="prominent"
            pulse={highestSeverity === 'error'}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs p-0" sideOffset={8}>
        <div className="space-y-0">
          <div className="border-b border-border/50 bg-muted/30 px-3 py-2">
            <p className="text-xs font-medium text-foreground">
              {triggeredAlerts.length} alert{triggeredAlerts.length > 1 ? 's' : ''} triggered
            </p>
          </div>
          <ul className="divide-y divide-border/30">
            {sortedAlerts.slice(0, 5).map((ta, idx) => {
              const operatorLabel =
                ALERT_OPERATOR_LABELS[ta.alert.operator as keyof typeof ALERT_OPERATOR_LABELS];
              return (
                <li key={idx} className="flex items-start gap-2.5 px-3 py-2">
                  <AlertBadge severity={ta.alert.severity} showIcon size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">{ta.alert.name}</p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      <span className="font-mono">
                        {formatAlertValue(ta.actualValue, ta.alert.field as AlertField)}
                      </span>
                      <span className="mx-1 opacity-50">·</span>
                      <span>
                        threshold {operatorLabel}{' '}
                        {formatAlertValue(ta.alert.value, ta.alert.field as AlertField)}
                      </span>
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
          {sortedAlerts.length > 5 && (
            <div className="border-t border-border/50 bg-muted/20 px-3 py-1.5">
              <p className="text-[10px] text-muted-foreground">
                +{sortedAlerts.length - 5} more alert{sortedAlerts.length - 5 > 1 ? 's' : ''}
              </p>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
