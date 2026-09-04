import { ArrowDownToLine, Loader2, TerminalSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { buildPresetQuery } from './presetQueries';
import { QueryResultTable } from './QueryResultTable';
import { SectionError } from './SectionError';
import type { QueryRunnerResult } from './types';

export function SqlRunnerPanel({
  dataset,
  sql,
  setSql,
  result,
  error,
  pending,
  onRun,
  onExportResult,
}: {
  dataset: string | undefined;
  sql: string;
  setSql: (value: string) => void;
  result: QueryRunnerResult | null;
  error: string;
  pending: boolean;
  onRun: () => void;
  onExportResult: () => void;
}) {
  return (
    <Card className="bg-card/40">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Guarded SQL Runner</CardTitle>
            <CardDescription>
              Read-only `SELECT` against the configured dataset. Queries must include
              `__TIME_FILTER__`.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="text-xs"
              onClick={() => dataset && setSql(buildPresetQuery(dataset, 'slow'))}
            >
              Slow Requests
            </Button>
            <Button
              variant="outline"
              className="text-xs"
              onClick={() => dataset && setSql(buildPresetQuery(dataset, 'skips'))}
            >
              Skip Reasons
            </Button>
            <Button
              variant="outline"
              className="text-xs"
              onClick={() => dataset && setSql(buildPresetQuery(dataset, 'orgs'))}
            >
              Top Orgs
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <textarea
          id="sql-runner"
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          className="tabular-mono min-h-[220px] w-full rounded-xl border border-border bg-background/60 p-4 text-[13px] outline-none ring-0"
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => onRun()} disabled={pending || !sql.trim()}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <TerminalSquare className="h-4 w-4" />
            )}
            Run Query
          </Button>
          <Button variant="outline" onClick={onExportResult} disabled={!result}>
            <ArrowDownToLine className="h-4 w-4" />
            Export Results
          </Button>
        </div>
        {error && <SectionError message={error} />}
        {result && (
          <>
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="border-b border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                Final SQL
              </div>
              <pre className="tabular-mono overflow-x-auto bg-background/60 p-4 text-[11px] text-muted-foreground">
                {result.sql}
              </pre>
            </div>
            <QueryResultTable result={result} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
