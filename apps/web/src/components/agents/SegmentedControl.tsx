'use client';

import { cn } from '@/lib/utils';

/**
 * A small bordered button group for picking one of a few options — the dashboard's
 * standard inline toggle (metric switchers, group-by, chart style). One styling source
 * so every toolbar toggle on the agents page reads the same.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="flex rounded-lg border border-border/60" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'px-2 py-1 text-[11px] font-medium transition-colors first:rounded-l-lg last:rounded-r-lg',
            value === option.value
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
