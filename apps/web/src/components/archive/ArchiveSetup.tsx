'use client';

import { useRef, useState } from 'react';
import { type Preloaded, useMutation, usePreloadedQuery } from 'convex/react';
import { api } from '@trace-flow/convex/_generated/api';
import type { Id } from '@trace-flow/convex/_generated/dataModel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ARCHIVE_SOURCES,
  buildAuthorizedSources,
  defaultArchiveConsentDraft,
  enrollmentAttemptFor,
  isCollectorActivelyEnrolled,
  type ArchiveConsentDraft,
  type ArchiveSource,
  type EnrollmentAttempt,
} from './archiveSetupModel';

interface ArchiveSetupProps {
  preloadedStatus: Preloaded<typeof api.archive.getStatus>;
  preloadedCollectors: Preloaded<typeof api.collectorCredentials.listActiveForCurrentUser>;
}

const SOURCE_LABELS: Record<ArchiveSource, string> = { claude: 'Claude', codex: 'Codex' };

export function ArchiveSetup({ preloadedStatus, preloadedCollectors }: ArchiveSetupProps) {
  const status = usePreloadedQuery(preloadedStatus);
  const collectors = usePreloadedQuery(preloadedCollectors);
  const activate = useMutation(api.archive.activate);
  const enroll = useMutation(api.archive.enroll);
  const [drafts, setDrafts] = useState<Record<string, ArchiveConsentDraft>>({});
  const attempts = useRef(new Map<string, EnrollmentAttempt>());
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftFor = (id: string) => drafts[id] ?? defaultArchiveConsentDraft();

  const updateDraft = (
    id: string,
    update: (current: ArchiveConsentDraft) => ArchiveConsentDraft,
  ) => {
    setDrafts((current) => ({
      ...current,
      [id]: update(current[id] ?? defaultArchiveConsentDraft()),
    }));
    setError(null);
  };

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

  const handleEnroll = async (collectorCredentialId: Id<'collectorCredentials'>) => {
    const key = String(collectorCredentialId);
    const authorizedSources = buildAuthorizedSources(draftFor(key));
    if (authorizedSources.length === 0) {
      setError('Select at least one source');
      return;
    }

    const attempt = enrollmentAttemptFor(
      collectorCredentialId,
      authorizedSources,
      attempts.current.get(key) ?? null,
      () => crypto.randomUUID(),
    );
    attempts.current.set(key, attempt);
    setSubmitting(key);
    setError(null);
    try {
      await enroll({
        collectorCredentialId,
        authorizedSources,
        idempotencyKey: attempt.idempotencyKey,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Collector enrollment failed');
    } finally {
      setSubmitting(null);
    }
  };

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
            Setup uses your website session. Desktop keeps using its existing Collector Credential.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {status.lifecycle === 'not_enabled' && (
            <Button type="button" onClick={handleActivate} disabled={activating}>
              {activating ? 'Enabling...' : 'Enable archive'}
            </Button>
          )}

          {collectors.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Connect Trace Flow Desktop first, then reload this page.
            </p>
          ) : (
            collectors.map((collector) => {
              const key = String(collector._id);
              const enrolled = isCollectorActivelyEnrolled(status.contributions, collector._id);
              const draft = draftFor(key);

              return (
                <section key={key} className="space-y-4 border-t pt-5 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium">{collector.name || 'Trace Flow Desktop'}</p>
                      {collector.platform && (
                        <p className="text-sm text-muted-foreground">{collector.platform}</p>
                      )}
                    </div>
                    {enrolled && <Badge>Enrolled</Badge>}
                  </div>

                  {!enrolled && status.lifecycle === 'active' && (
                    <form
                      className="space-y-5"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void handleEnroll(collector._id);
                      }}
                    >
                      {ARCHIVE_SOURCES.map((source) => (
                        <fieldset key={source} className="space-y-3 rounded-lg border p-4">
                          <label className="flex items-center gap-2 font-medium">
                            <input
                              type="checkbox"
                              checked={draft.selected[source]}
                              onChange={(event) =>
                                updateDraft(key, (current) => ({
                                  ...current,
                                  selected: { ...current.selected, [source]: event.target.checked },
                                }))
                              }
                            />
                            {SOURCE_LABELS[source]}
                          </label>

                          {draft.selected[source] && (
                            <div className="space-y-2 pl-6">
                              {(
                                [
                                  ['all_history', 'Existing and new conversations'],
                                  ['new_only', 'New conversations'],
                                ] as const
                              ).map(([choice, label]) => (
                                <label key={choice} className="flex items-center gap-2 text-sm">
                                  <input
                                    type="radio"
                                    name={`${key}-${source}-history`}
                                    value={choice}
                                    checked={draft.historyChoices[source] === choice}
                                    onChange={() =>
                                      updateDraft(key, (current) => ({
                                        ...current,
                                        historyChoices: {
                                          ...current.historyChoices,
                                          [source]: choice,
                                        },
                                      }))
                                    }
                                  />
                                  {label}
                                </label>
                              ))}
                            </div>
                          )}
                        </fieldset>
                      ))}

                      <Button type="submit" disabled={submitting === key}>
                        {submitting === key ? 'Enrolling...' : 'Confirm and enroll'}
                      </Button>
                    </form>
                  )}
                </section>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
