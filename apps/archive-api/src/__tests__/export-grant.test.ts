import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_EXPORT_GRANT_AUDIENCE,
  ARCHIVE_EXPORT_GRANT_ISSUER,
  ARCHIVE_EXPORT_GRANT_SCOPE,
  authenticateArchiveExportGrant,
} from '../export-grant';

const SECRET = 'archive-shared-secret';
const IDS = {
  orgId: 'k57axc8sefsfp6k28nx6c481js806pwv',
  actorUserId: 'j57axc8sefsfp6k28nx6c481js806pwv',
  userId: 'j57axc8sefsfp6k28nx6c481js806pwv',
  contributionId: 'n57axc8sefsfp6k28nx6c481js806pwv',
  sourceSessionId: 'session-1',
};

async function token(overrides: Record<string, unknown> = {}, secret = SECRET): Promise<string> {
  return new SignJWT({
    scope: ARCHIVE_EXPORT_GRANT_SCOPE,
    orgId: IDS.orgId,
    exportId: 'export-1',
    actorUserId: IDS.actorUserId,
    targets: [
      {
        userId: IDS.userId,
        contributionId: IDS.contributionId,
        source: 'claude',
        sourceSessionId: IDS.sourceSessionId,
      },
    ],
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ARCHIVE_EXPORT_GRANT_ISSUER)
    .setAudience(ARCHIVE_EXPORT_GRANT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(secret));
}

describe('Archive Export Grant', () => {
  it('verifies an owner-issued grant and its exact session scope', async () => {
    await expect(
      authenticateArchiveExportGrant(await token(), undefined, undefined, SECRET),
    ).resolves.toMatchObject({
      ok: true,
      grant: {
        orgId: IDS.orgId,
        exportId: 'export-1',
        actorUserId: IDS.actorUserId,
        targets: [{ contributionId: IDS.contributionId, sourceSessionId: IDS.sourceSessionId }],
      },
    });
  });

  it('rejects missing, forged, expired, and malformed grants', async () => {
    await expect(
      authenticateArchiveExportGrant(undefined, undefined, undefined, SECRET),
    ).resolves.toEqual({ ok: false, reason: 'missing' });
    await expect(
      authenticateArchiveExportGrant(await token({}, 'wrong-secret'), undefined, undefined, SECRET),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(
      authenticateArchiveExportGrant(await token({ targets: [] }), undefined, undefined, SECRET),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a valid grant when another credential class is present', async () => {
    await expect(
      authenticateArchiveExportGrant(await token(), 'Bearer pipe-token', undefined, SECRET),
    ).resolves.toEqual({ ok: false, reason: 'invalid_credential_class' });
    await expect(
      authenticateArchiveExportGrant(await token(), undefined, 'tf_session=abc', SECRET),
    ).resolves.toEqual({ ok: false, reason: 'invalid_credential_class' });
  });
});
