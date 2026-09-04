import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { BreakdownTable } from './BreakdownTable';
import { LoadingState } from './LoadingState';
import { SectionError } from './SectionError';
import type { BreakdownDimension, BreakdownRow } from './types';

export function BreakdownsPanel({
  activeDimension,
  onDimensionChange,
  isLoading,
  error,
  rows,
  search,
  setSearch,
}: {
  activeDimension: BreakdownDimension;
  onDimensionChange: (value: BreakdownDimension) => void;
  isLoading: boolean;
  error: string;
  rows: BreakdownRow[];
  search: string;
  setSearch: (value: string) => void;
}) {
  return (
    <>
      <Card className="bg-card/40">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Dimension Analysis</CardTitle>
              <CardDescription>
                Compare request volume, latency, and errors by dimension.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  'provider',
                  'statusCode',
                  'operation',
                  'model',
                  'skipReason',
                  'orgId',
                ] as BreakdownDimension[]
              ).map((dimension) => (
                <button
                  key={dimension}
                  onClick={() => onDimensionChange(dimension)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                    activeDimension === dimension
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background text-muted-foreground hover:text-foreground',
                  )}
                >
                  {dimension}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
      </Card>
      {isLoading ? (
        <LoadingState label="Loading grouped breakdowns..." />
      ) : error ? (
        <SectionError message={error} />
      ) : (
        <BreakdownTable rows={rows} search={search} onSearchChange={setSearch} />
      )}
    </>
  );
}
