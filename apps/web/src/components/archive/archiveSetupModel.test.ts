import { describe, expect, it, vi } from 'vitest';
import type { Id } from '@trace-flow/convex/_generated/dataModel';
import {
  buildAuthorizedSources,
  defaultArchiveConsentDraft,
  enrollmentAttemptFor,
  isCollectorActivelyEnrolled,
} from './archiveSetupModel';

const collectorCredentialId = 'collector-credential-1' as Id<'collectorCredentials'>;

describe('archive setup model', () => {
  it('serializes each selected source with its explicit history choice', () => {
    const draft = defaultArchiveConsentDraft();
    draft.historyChoices.codex = 'new_only';

    expect(buildAuthorizedSources(draft)).toEqual([
      { source: 'claude', historyChoice: 'all_history' },
      { source: 'codex', historyChoice: 'new_only' },
    ]);

    draft.selected.claude = false;
    expect(buildAuthorizedSources(draft)).toEqual([{ source: 'codex', historyChoice: 'new_only' }]);
  });

  it('reuses an idempotency key for an identical retry and changes it with consent', () => {
    const createId = vi.fn().mockReturnValueOnce('first').mockReturnValueOnce('second');
    const allHistory = [{ source: 'claude' as const, historyChoice: 'all_history' as const }];
    const first = enrollmentAttemptFor(collectorCredentialId, allHistory, null, createId);
    const retry = enrollmentAttemptFor(collectorCredentialId, allHistory, first, createId);
    const changed = enrollmentAttemptFor(
      collectorCredentialId,
      [{ source: 'claude', historyChoice: 'new_only' }],
      retry,
      createId,
    );

    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(createId).toHaveBeenCalledTimes(2);
  });

  it('counts only an active enrollment for the matching collector credential', () => {
    const contributions = [
      {
        collectors: [
          { collectorCredentialId, status: 'revoked' as const },
          {
            collectorCredentialId: 'collector-credential-2' as Id<'collectorCredentials'>,
            status: 'active' as const,
          },
        ],
      },
    ];

    expect(isCollectorActivelyEnrolled(contributions, collectorCredentialId)).toBe(false);
    expect(
      isCollectorActivelyEnrolled(
        [...contributions, { collectors: [{ collectorCredentialId, status: 'active' as const }] }],
        collectorCredentialId,
      ),
    ).toBe(true);
  });
});
