import { isArchiveCanonicalIdentifier } from '@trace-flow/types';
import { jwtVerify } from 'jose';
import type { ArchiveSource } from './archive-contract';

export const ARCHIVE_EXPORT_GRANT_HEADER = 'X-Trace-Flow-Archive-Export-Grant';
export const ARCHIVE_EXPORT_GRANT_ISSUER = 'trace-flow-convex';
export const ARCHIVE_EXPORT_GRANT_AUDIENCE = 'trace-flow-archive-api';
export const ARCHIVE_EXPORT_GRANT_SCOPE = 'archive:export';

export interface ArchiveExportTarget {
  userId: string;
  contributionId: string;
  source: ArchiveSource;
  sourceSessionId: string;
}

interface ArchiveExportGrantBase {
  orgId: string;
  exportId: string;
  actorUserId: string;
  issuedAt: number;
  expiresAt: number;
}

export type ArchiveExportGrant = ArchiveExportGrantBase &
  (
    | { exportScope: 'organization'; targets?: never }
    | { exportScope: 'targets'; targets: ArchiveExportTarget[] }
  );

export type ArchiveExportGrantFailure = 'missing' | 'invalid' | 'invalid_credential_class';
export type ArchiveExportGrantResult =
  | { ok: true; grant: ArchiveExportGrant }
  | { ok: false; reason: ArchiveExportGrantFailure };

export function hasForeignCredentialClass(
  authorizationHeader: string | undefined,
  cookieHeader: string | undefined,
): boolean {
  return Boolean(authorizationHeader) || Boolean(cookieHeader);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && isArchiveCanonicalIdentifier(value);
}

function validExportId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  );
}

function parseTargets(value: unknown): ArchiveExportTarget[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return null;
  const targets: ArchiveExportTarget[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const target = entry as Record<string, unknown>;
    if (
      !validId(target.userId) ||
      !validId(target.contributionId) ||
      (target.source !== 'claude' && target.source !== 'codex') ||
      !validId(target.sourceSessionId)
    ) {
      return null;
    }
    const identity = `${target.contributionId}\0${target.source}\0${target.sourceSessionId}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    targets.push({
      userId: target.userId,
      contributionId: target.contributionId,
      source: target.source,
      sourceSessionId: target.sourceSessionId,
    });
  }
  return targets;
}

export async function authenticateArchiveExportGrant(
  grantHeader: string | undefined,
  authorizationHeader: string | undefined,
  cookieHeader: string | undefined,
  sharedSecret: string,
): Promise<ArchiveExportGrantResult> {
  if (hasForeignCredentialClass(authorizationHeader, cookieHeader)) {
    return { ok: false, reason: 'invalid_credential_class' };
  }
  if (!grantHeader) return { ok: false, reason: 'missing' };
  if (!sharedSecret) return { ok: false, reason: 'invalid' };
  try {
    const { payload, protectedHeader } = await jwtVerify(
      grantHeader,
      new TextEncoder().encode(sharedSecret),
      {
        issuer: ARCHIVE_EXPORT_GRANT_ISSUER,
        audience: ARCHIVE_EXPORT_GRANT_AUDIENCE,
        algorithms: ['HS256'],
      },
    );
    const exportScope = payload.exportScope;
    const targets = payload.targets === undefined ? undefined : parseTargets(payload.targets);
    if (
      protectedHeader.alg !== 'HS256' ||
      payload.scope !== ARCHIVE_EXPORT_GRANT_SCOPE ||
      !validId(payload.orgId) ||
      !validExportId(payload.exportId) ||
      !validId(payload.actorUserId) ||
      typeof payload.iat !== 'number' ||
      !Number.isSafeInteger(payload.iat) ||
      typeof payload.exp !== 'number' ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= payload.iat ||
      payload.iat > Math.floor(Date.now() / 1000) + 30 ||
      (exportScope !== 'organization' && exportScope !== 'targets') ||
      (exportScope === 'organization'
        ? payload.targets !== undefined || payload.exp - payload.iat > 24 * 60 * 60
        : !targets || payload.exp - payload.iat > 10 * 60)
    ) {
      return { ok: false, reason: 'invalid' };
    }
    const base = {
      orgId: payload.orgId,
      exportId: payload.exportId,
      actorUserId: payload.actorUserId,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
    return exportScope === 'organization'
      ? { ok: true, grant: { ...base, exportScope } }
      : { ok: true, grant: { ...base, exportScope, targets: targets! } };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
