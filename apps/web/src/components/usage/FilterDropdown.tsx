'use client';

import { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { sortFilterOptions } from '@/lib/sortFilterOptions';

export function FilterDropdown({
  label,
  value,
  options,
  onChange,
  labelMap,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (val: string) => void;
  labelMap?: Map<string, string>;
}) {
  const sortedOptions = useMemo(() => sortFilterOptions(options, labelMap), [options, labelMap]);
  const hasValue = value !== '';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors',
          'hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20',
          hasValue ? 'text-foreground' : 'text-foreground',
        )}
      >
        <span className="max-w-[140px] truncate">
          {hasValue ? (labelMap?.get(value) ?? value) : label}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-48 min-w-40 overflow-y-auto">
        <DropdownMenuItem
          onClick={() => onChange('')}
          className={cn('text-xs', !hasValue && 'bg-muted font-medium')}
        >
          All {label}s
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {sortedOptions.map((opt) => (
          <DropdownMenuItem
            key={opt}
            onClick={() => onChange(opt)}
            className={cn('text-xs', value === opt && 'bg-muted font-medium')}
          >
            {labelMap?.get(opt) ?? opt}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
