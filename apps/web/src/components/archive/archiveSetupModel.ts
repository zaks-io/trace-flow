import type { Id } from '@trace-flow/convex/_generated/dataModel';

export const ARCHIVE_SOURCES = ['claude', 'codex'] as const;

export type ArchiveSource = (typeof ARCHIVE_SOURCES)[number];
export type ArchiveHistoryChoice = 'all_history' | 'new_only';

export function collectorCredentialLifetimeLabel(expiresAt?: number): string {
  return expiresAt === undefined ? 'Until revoked' : new Date(expiresAt).toLocaleDateString();
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
