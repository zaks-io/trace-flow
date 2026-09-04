import { describe, expect, it } from 'vitest';
import { authenticateArchiveExportGrant, type ArchiveExportGrant } from '../export-grant';

function exampleGrant(): ArchiveExportGrant {
  return {
    orgId: 'k57axc8sefsfp6k28nx6c481js806pwv',
    exportId: 'export-1',
    actorUserId: 'j57axc8sefsfp6k28nx6c481js806pwv',
    issuedAt: 1,
    expiresAt: 2,
  };
}

describe('Archive Export Grant placeholder', () => {
  it('fails closed when no grant is present', () => {
    expect(authenticateArchiveExportGrant(undefined, undefined, undefined)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('fails closed even when a grant header is supplied', () => {
    expect(authenticateArchiveExportGrant('placeholder-grant', undefined, undefined)).toEqual({
      ok: false,
      reason: 'grant_unavailable',
    });
    expect(exampleGrant().exportId).toBe('export-1');
  });

  it('rejects Pipe Tokens, Body Access Tokens, API Keys, and browser sessions', () => {
    expect(authenticateArchiveExportGrant(undefined, 'Bearer pipe-token', undefined)).toEqual({
      ok: false,
      reason: 'invalid_credential_class',
    });
    expect(authenticateArchiveExportGrant(undefined, 'Bearer body-access', undefined)).toEqual({
      ok: false,
      reason: 'invalid_credential_class',
    });
    expect(authenticateArchiveExportGrant(undefined, 'Bearer tf_live_key', undefined)).toEqual({
      ok: false,
      reason: 'invalid_credential_class',
    });
    expect(authenticateArchiveExportGrant(undefined, undefined, 'tf_session=abc')).toEqual({
      ok: false,
      reason: 'invalid_credential_class',
    });
  });

  it('rejects a grant header when a foreign credential class is also present', () => {
    expect(
      authenticateArchiveExportGrant('placeholder-grant', 'Bearer pipe-token', undefined),
    ).toEqual({
      ok: false,
      reason: 'invalid_credential_class',
    });
    expect(
      authenticateArchiveExportGrant('placeholder-grant', undefined, 'tf_session=abc'),
    ).toEqual({
      ok: false,
      reason: 'invalid_credential_class',
    });
  });
});
