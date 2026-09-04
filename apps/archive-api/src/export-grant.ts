/**
 * Archive Export Grant contract. Minting is out of scope for this slice, so every
 * verification fails closed. Collector Credentials, Pipe Tokens, Body Access Tokens,
 * API Keys, and browser sessions are the wrong credential class.
 */
export const ARCHIVE_EXPORT_GRANT_HEADER = 'X-Trace-Flow-Archive-Export-Grant';

export interface ArchiveExportGrant {
  orgId: string;
  exportId: string;
  actorUserId: string;
  issuedAt: number;
  expiresAt: number;
}

export type ArchiveExportGrantFailure =
  | 'missing'
  | 'grant_unavailable'
  | 'invalid_credential_class';

export interface ArchiveExportGrantResult {
  ok: false;
  reason: ArchiveExportGrantFailure;
}

export function hasForeignCredentialClass(
  authorizationHeader: string | undefined,
  cookieHeader: string | undefined,
): boolean {
  return Boolean(authorizationHeader) || Boolean(cookieHeader);
}

/**
 * Placeholder verifier. A grant header cannot succeed until Convex mints grants.
 * Any other credential class is rejected without inspecting its value.
 */
export function authenticateArchiveExportGrant(
  grantHeader: string | undefined,
  authorizationHeader: string | undefined,
  cookieHeader: string | undefined,
): ArchiveExportGrantResult {
  if (hasForeignCredentialClass(authorizationHeader, cookieHeader)) {
    return { ok: false, reason: 'invalid_credential_class' };
  }
  if (!grantHeader) {
    return { ok: false, reason: 'missing' };
  }
  return { ok: false, reason: 'grant_unavailable' };
}
