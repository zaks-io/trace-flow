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
  historyChoices: Record<ArchiveSource, ArchiveHistoryChoice | null>;
}

export interface EnrollmentAttempt {
  signature: string;
  idempotencyKey: string;
}

export function defaultArchiveConsentDraft(): ArchiveConsentDraft {
  return {
    selected: { claude: true, codex: true },
    historyChoices: { claude: null, codex: null },
  };
}

export function selectedSourceMissingHistoryChoice(
  draft: ArchiveConsentDraft,
): ArchiveSource | null {
  return (
    ARCHIVE_SOURCES.find(
      (source) => draft.selected[source] && draft.historyChoices[source] === null,
    ) ?? null
  );
}

export function buildAuthorizedSources(draft: ArchiveConsentDraft): ArchiveSourceChoice[] {
  const missing = selectedSourceMissingHistoryChoice(draft);
  if (missing) throw new Error(`History choice is required for ${missing}`);
  return ARCHIVE_SOURCES.filter((source) => draft.selected[source]).map((source) => {
    const historyChoice = draft.historyChoices[source];
    if (!historyChoice) throw new Error(`History choice is required for ${source}`);
    return { source, historyChoice };
  });
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
