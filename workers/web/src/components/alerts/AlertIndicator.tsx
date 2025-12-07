import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertBadge } from './AlertBadge';
import type { TriggeredAlert, AlertSeverity } from '@/types/alerts';
import { getHighestSeverity } from '@/lib/alerts';

interface AlertIndicatorProps {
  triggeredAlerts: TriggeredAlert[];
}

export function AlertIndicator({ triggeredAlerts }: AlertIndicatorProps) {
  if (triggeredAlerts.length === 0) return null;

  const severities = triggeredAlerts.map((t) => t.alert.severity as AlertSeverity);
  const highestSeverity = getHighestSeverity(severities);

  if (!highestSeverity) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-pointer">
          <AlertBadge severity={highestSeverity} count={triggeredAlerts.length} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        <div className="space-y-1.5">
          <p className="text-xs font-medium">
            {triggeredAlerts.length} alert{triggeredAlerts.length > 1 ? 's' : ''} triggered
          </p>
          <ul className="space-y-1">
            {triggeredAlerts.map((ta, idx) => (
              <li key={idx} className="flex items-center gap-2 text-xs">
                <AlertBadge severity={ta.alert.severity} showIcon={false} />
                <span className="text-muted-foreground">{ta.alert.name}</span>
              </li>
            ))}
          </ul>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
