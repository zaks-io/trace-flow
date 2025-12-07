import { AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AlertBadgeProps {
  severity: string;
  count?: number;
  showIcon?: boolean;
  size?: 'sm' | 'md';
  variant?: 'default' | 'prominent';
  pulse?: boolean;
}

const severityConfig: Record<
  string,
  {
    bg: string;
    text: string;
    border: string;
    glow: string;
    pulseColor: string;
  }
> = {
  info: {
    bg: 'bg-blue-500/10',
    text: 'text-blue-400',
    border: 'border-blue-500/35',
    glow: 'shadow-[0_0_10px_rgba(59,130,246,0.2)]',
    pulseColor: 'before:bg-blue-400',
  },
  warning: {
    bg: 'bg-amber-500/10',
    text: 'text-amber-400',
    border: 'border-amber-500/40',
    glow: 'shadow-[0_0_12px_rgba(245,158,11,0.25)]',
    pulseColor: 'before:bg-amber-400',
  },
  error: {
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    border: 'border-red-500/40',
    glow: 'shadow-[0_0_12px_rgba(239,68,68,0.3)]',
    pulseColor: 'before:bg-red-400',
  },
};

const severityIcons: Record<string, React.ElementType> = {
  info: Info,
  warning: AlertTriangle,
  error: AlertCircle,
};

export function AlertBadge({
  severity,
  count,
  showIcon = true,
  size = 'sm',
  variant = 'default',
  pulse = false,
}: AlertBadgeProps) {
  const Icon = severityIcons[severity] ?? Info;
  const config = severityConfig[severity] ?? severityConfig.info;

  const sizeClasses = size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs';
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';

  const isProminent = variant === 'prominent';
  const shouldPulse = pulse && (severity === 'error' || severity === 'warning');

  return (
    <span
      className={cn(
        'relative inline-flex items-center gap-1 rounded-full border font-medium transition-shadow',
        config.bg,
        config.text,
        config.border,
        sizeClasses,
        isProminent && config.glow,
        shouldPulse && [
          'before:absolute before:inset-0 before:rounded-full before:animate-ping before:opacity-30',
          config.pulseColor,
        ],
      )}
    >
      {showIcon && <Icon className={cn(iconSize, 'relative z-10')} />}
      {count !== undefined && count > 0 && <span className="relative z-10">{count}</span>}
    </span>
  );
}
