'use client';

import { useState } from 'react';
import { type Preloaded, useMutation, usePreloadedQuery } from 'convex/react';
import { api } from '@trace-flow/convex/_generated/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ArchiveHistoryChoice, ArchiveSource } from './archiveSetupModel';

interface ArchiveSetupProps {
  preloadedStatus: Preloaded<typeof api.archive.getStatus>;
  preloadedCollectors: Preloaded<typeof api.collectorCredentials.listActiveForCurrentUser>;
}

const SOURCE_LABELS: Record<ArchiveSource, string> = { claude: 'Claude', codex: 'Codex' };

export function ArchiveSetup({ preloadedStatus, preloadedCollectors }: ArchiveSetupProps) {
  const status = usePreloadedQuery(preloadedStatus);
  const collectors = usePreloadedQuery(preloadedCollectors);
  const activate = useMutation(api.archive.activate);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleActivate = async () => {
    setActivating(true);
    setError(null);
    try {
      await activate({});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Archive activation failed');
    } finally {
      setActivating(false);
    }
  };

  const activeCollectors = status.contributions.flatMap((contribution) =>
    contribution.collectors.filter((collector) => collector.status === 'active'),
  );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Conversation Archive</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose which Desktop conversations to preserve for your organization.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Archive setup</CardTitle>
            <Badge variant={status.lifecycle === 'active' ? 'default' : 'secondary'}>
              {status.lifecycle === 'not_enabled' ? 'Not enabled' : status.lifecycle}
            </Badge>
          </div>
          <CardDescription>
            Choose Sources and conversation history from the Archive menu in Trace Flow Desktop.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {status.lifecycle === 'not_enabled' && (
            <Button type="button" onClick={handleActivate} disabled={activating}>
              {activating ? 'Enabling...' : 'Enable archive'}
            </Button>
          )}

          {activeCollectors.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Desktop collector is enrolled yet.</p>
          ) : (
            activeCollectors.map((collector) => {
              const credential = collectors.find(
                (candidate) => candidate._id === collector.collectorCredentialId,
              );

              return (
                <section
                  key={collector.enrollmentId}
                  className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium">{credential?.name || 'Trace Flow Desktop'}</p>
                      {credential?.platform && (
                        <p className="text-sm text-muted-foreground">{credential.platform}</p>
                      )}
                    </div>
                    <Badge>Enrolled</Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {collector.authorizedSources.map((authorized) => (
                      <Badge key={authorized.source} variant="secondary">
                        {SOURCE_LABELS[authorized.source]} ·{' '}
                        {historyChoiceLabel(authorized.historyChoice)}
                      </Badge>
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function historyChoiceLabel(choice: ArchiveHistoryChoice): string {
  return choice === 'all_history' ? 'Existing and new conversations' : 'New conversations';
}
