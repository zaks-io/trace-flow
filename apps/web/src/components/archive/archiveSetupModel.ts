import type { Id } from '@trace-flow/convex/_generated/dataModel';

export const ARCHIVE_SOURCES = ['claude', 'codex'] as const;

export type ArchiveSource = (typeof ARCHIVE_SOURCES)[number];
export type ArchiveHistoryChoice = 'all_history' | 'new_only';

export interface ArchiveSourceChoice {
  source: ArchiveSource;
  historyChoice: ArchiveHistoryChoice;
}

export interface ArchiveConsentDraft {
  selected: Record<ArchiveSource, boolean>;
  historyChoices: Record<ArchiveSource, ArchiveHistoryChoice>;
}

export interface EnrollmentAttempt {
  signature: string;
  idempotencyKey: string;
}

export function defaultArchiveConsentDraft(): ArchiveConsentDraft {
  return {
    selected: { claude: true, codex: true },
    historyChoices: { claude: 'all_history', codex: 'all_history' },
  };
}

export function buildAuthorizedSources(draft: ArchiveConsentDraft): ArchiveSourceChoice[] {
  return ARCHIVE_SOURCES.filter((source) => draft.selected[source]).map((source) => ({
    source,
    historyChoice: draft.historyChoices[source],
  }));
}

export function enrollmentAttemptFor(
  collectorCredentialId: Id<'collectorCredentials'>,
  authorizedSources: ArchiveSourceChoice[],
  previous: EnrollmentAttempt | null,
  createId: () => string,
): EnrollmentAttempt {
  const signature = JSON.stringify({ collectorCredentialId, authorizedSources });
  if (previous?.signature === signature) return previous;
  return { signature, idempotencyKey: `archive-enroll:${createId()}` };
}

export function isCollectorActivelyEnrolled(
  contributions: Array<{
    collectors: Array<{
      collectorCredentialId: Id<'collectorCredentials'>;
      status: 'active' | 'unenrolled' | 'revoked' | 'member_removed';
    }>;
  }>,
  collectorCredentialId: Id<'collectorCredentials'>,
): boolean {
  return contributions.some((contribution) =>
    contribution.collectors.some(
      (collector) =>
        collector.collectorCredentialId === collectorCredentialId && collector.status === 'active',
    ),
  );
}
