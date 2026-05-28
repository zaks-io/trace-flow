'use client';

import { useMemo } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { sortFilterOptions } from '@/lib/sortFilterOptions';

/**
 * Multi-select sibling of FilterDropdown: any subset of options can be selected, the menu
 * stays open while toggling, and the trigger shows a count. Empty selection = "All".
 */
export function MultiFilterDropdown({
  label,
  values,
  options,
  onToggle,
  onClear,
}: {
  label: string;
  values: string[];
  options: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const sortedOptions = useMemo(() => sortFilterOptions(options), [options]);
  const count = values.length;
  const hasValue = count > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors',
          'hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20',
          hasValue ? 'border-primary/30 bg-primary/10 text-primary' : 'text-foreground',
        )}
      >
        <span className="max-w-[140px] truncate">{hasValue ? `${label} · ${count}` : label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-60 min-w-44 overflow-y-auto">
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            onClear();
          }}
          className={cn('text-xs', !hasValue && 'bg-muted font-medium')}
        >
          All {label}s
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {sortedOptions.length === 0 && (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            No options yet
          </DropdownMenuItem>
        )}
        {sortedOptions.map((opt) => {
          const selected = values.includes(opt);
          return (
            <DropdownMenuItem
              key={opt}
              onSelect={(e) => {
                e.preventDefault();
                onToggle(opt);
              }}
              className={cn('flex items-center gap-2 text-xs', selected && 'font-medium')}
            >
              <Check className={cn('h-3 w-3 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
              <span className="truncate">{opt}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
