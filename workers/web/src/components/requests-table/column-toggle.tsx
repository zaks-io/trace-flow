'use client';

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Settings2 } from 'lucide-react';
import type { Table } from '@tanstack/react-table';

const categoryLabels: Record<string, string> = {
  standard: 'Standard',
  ai: 'AI',
  http: 'HTTP',
};

const categoryOrder = ['standard', 'ai', 'http'];

interface ColumnToggleProps<TData> {
  table: Table<TData>;
}

export function ColumnToggle<TData>({ table }: ColumnToggleProps<TData>) {
  const columns = table.getAllLeafColumns();

  const grouped = columns.reduce(
    (acc, column) => {
      const meta = column.columnDef.meta as { category?: string; label?: string } | undefined;
      const category = meta?.category ?? 'standard';
      acc[category] ??= [];
      acc[category].push(column);
      return acc;
    },
    {} as Record<string, typeof columns>,
  );

  const sortedCategories = categoryOrder.filter((cat) => (grouped[cat]?.length ?? 0) > 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Settings2 className="h-4 w-4" />
          <span>Columns</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {sortedCategories.map((category, index) => {
          const cols = grouped[category] ?? [];
          return (
            <div key={category}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{categoryLabels[category] ?? category}</DropdownMenuLabel>
              {cols.map((column) => {
                const meta = column.columnDef.meta as { label?: string } | undefined;
                return (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) => column.toggleVisibility(value)}
                  >
                    {meta?.label ?? column.id}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
