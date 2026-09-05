import { hashFramed } from './archive-chain';
import {
  ArchiveContractError,
  assertArchiveSource,
  assertIdentifier,
  type ArchiveScope,
} from './archive-contract';

const ARCHIVE_ORGANIZATION_KEY_DOMAIN = new TextEncoder().encode(
  'trace-flow/archive/organization-key/v1',
);
const ARCHIVE_CONTRIBUTION_KEY_DOMAIN = new TextEncoder().encode(
  'trace-flow/archive/contribution-key/v1',
);
const ARCHIVE_SESSION_KEY_DOMAIN = new TextEncoder().encode('trace-flow/archive/session-key/v1');

async function derivedKey(domain: Uint8Array, values: string[]): Promise<string> {
  return (
    await hashFramed(
      domain,
      values.map((value) => new TextEncoder().encode(value)),
    )
  ).slice(7);
}

export async function archiveSessionPrefix(scope: ArchiveScope): Promise<string> {
  assertIdentifier(scope.orgId, 'invalid_scope');
  assertIdentifier(scope.userId, 'invalid_scope');
  assertIdentifier(scope.contributionId, 'invalid_scope');
  assertArchiveSource(scope.source);
  assertIdentifier(scope.sourceSessionId, 'invalid_scope');
  const organizationKey = await derivedKey(ARCHIVE_ORGANIZATION_KEY_DOMAIN, [scope.orgId]);
  const contributionKey = await derivedKey(ARCHIVE_CONTRIBUTION_KEY_DOMAIN, [
    scope.orgId,
    scope.contributionId,
  ]);
  const sessionKey = await derivedKey(ARCHIVE_SESSION_KEY_DOMAIN, [
    scope.orgId,
    scope.contributionId,
    scope.source,
    scope.sourceSessionId,
  ]);
  return `archive/${organizationKey}/contributions/${contributionKey}/sessions/${scope.source}/${sessionKey}`;
}

export async function archiveObjectKey(
  scope: ArchiveScope,
  objectClass: 'chunks' | 'manifests',
  hash: string,
): Promise<string> {
  if (!/^sha256:[0-9a-f]{64}$/u.test(hash)) {
    throw new ArchiveContractError('invalid_digest');
  }
  return `${await archiveSessionPrefix(scope)}/${objectClass}/${hash.slice(7)}`;
}
