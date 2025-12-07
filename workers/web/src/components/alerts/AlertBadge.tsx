import { AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AlertBadgeProps {
  severity: string;
  count?: number;
  showIcon?: boolean;
  size?: 'sm' | 'md';
}

const severityStyles: Record<string, string> = {
  info: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  warning: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  error: 'bg-red-500/20 text-red-400 border-red-500/30',
};

const severityIcons: Record<string, React.ElementType> = {
  info: Info,
  warning: AlertTriangle,
  error: AlertCircle,
};

export function AlertBadge({ severity, count, showIcon = true, size = 'sm' }: AlertBadgeProps) {
  const Icon = severityIcons[severity] ?? Info;
  const sizeClasses = size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs';
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium',
        severityStyles[severity] ?? severityStyles.info,
        sizeClasses,
      )}
    >
      {showIcon && <Icon className={iconSize} />}
      {count !== undefined && count > 1 && <span>{count}</span>}
    </span>
  );
}
