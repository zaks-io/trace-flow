import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BOOLEAN_COLUMNS, STATUS_FIELDS } from './constants';
import { formatBooleanCell, formatCellValue, formatInteger } from './format';
import type { ExplorerRow } from './types';

export function ExplorerRowDialog({
  row,
  onClose,
}: {
  row: ExplorerRow | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!row} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Explorer Row</DialogTitle>
          <DialogDescription>
            Inspect the raw Analytics Engine fields for the selected row.
          </DialogDescription>
        </DialogHeader>
        {row && (
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(row).map(([key, value]) => {
              const formatted =
                typeof value === 'number'
                  ? formatInteger(value)
                  : BOOLEAN_COLUMNS.has(key)
                    ? formatBooleanCell(String(value))
                    : formatCellValue(String(value));
              return (
                <div
                  key={key}
                  className="rounded-lg border border-border/60 border-l-2 border-l-border bg-background/40 p-3"
                >
                  <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                    {key}
                  </p>
                  {STATUS_FIELDS.has(key) ? (
                    <Badge variant="outline" className="tabular-mono mt-1 text-sm">
                      {formatted}
                    </Badge>
                  ) : (
                    <p className="tabular-mono mt-1 break-all text-sm">{formatted}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
