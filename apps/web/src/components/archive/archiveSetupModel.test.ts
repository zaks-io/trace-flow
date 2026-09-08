import { describe, expect, it } from 'vitest';
import type { Id } from '@trace-flow/convex/_generated/dataModel';
import { isCollectorActivelyEnrolled } from './archiveSetupModel';

describe('archive setup model', () => {
  it('matches only an active enrollment for the requested Collector Credential', () => {
    const requested = 'collector-credential-1' as Id<'collectorCredentials'>;
    const contributions = [
      {
        collectors: [
          { collectorCredentialId: requested, status: 'revoked' as const },
          {
            collectorCredentialId: 'collector-credential-2' as Id<'collectorCredentials'>,
            status: 'active' as const,
          },
        ],
      },
    ];

    expect(isCollectorActivelyEnrolled(contributions, requested)).toBe(false);
    expect(
      isCollectorActivelyEnrolled(
        [
          ...contributions,
          { collectors: [{ collectorCredentialId: requested, status: 'active' }] },
        ],
        requested,
      ),
    ).toBe(true);
  });
});
