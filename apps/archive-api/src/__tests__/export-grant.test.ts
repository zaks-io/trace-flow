import { describe, expect, it } from 'vitest';
import { authenticateArchiveExportGrant } from '../export-grant';

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
});
