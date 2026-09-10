import type { Context } from 'hono';
import type { ArchiveApiEnv } from './context';
import { ArchiveContractError, assertIdentifier } from './archive-contract';
import { readBoundedJson } from './archive-request';
import { archiveOrganizationPrefix } from './archive-storage-key';
import { hasInternalArchiveAuthority } from './internal-authority';

const MAX_ERASURE_REQUEST_BYTES = 128 * 1024;
const MAX_LEDGER_IDS = 100;
const R2_DELETE_BATCH_SIZE = 1000;

interface ArchiveErasureRequest {
  orgId: string;
  ledgerIds: string[];
  includeRegistered: boolean;
  registeredCursor?: string;
}

function unauthorized(c: Context<{ Bindings: ArchiveApiEnv }>): Response | null {
  if (hasInternalArchiveAuthority(c.req.header('Authorization'), c.env.ARCHIVE_API_SHARED_SECRET)) {
    return null;
  }
  return c.json({ error: 'unauthorized', reason: 'invalid_credential_class' }, 401);
}

async function parseErasureRequest(
  c: Context<{ Bindings: ArchiveApiEnv }>,
  includeLedgers: boolean,
): Promise<ArchiveErasureRequest> {
  const parsed = await readBoundedJson(
    c.req.raw,
    MAX_ERASURE_REQUEST_BYTES,
    'archive_erasure_request_too_large',
  );
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ArchiveContractError('archive_erasure_request_invalid');
  }
  const body = parsed as Record<string, unknown>;
  assertIdentifier(body.orgId, 'invalid_organization_id');
  const ledgerIds = body.ledgerIds ?? [];
  if (
    !Array.isArray(ledgerIds) ||
    ledgerIds.length > MAX_LEDGER_IDS ||
    ledgerIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id))
  ) {
    throw new ArchiveContractError('archive_erasure_ledger_ids_invalid');
  }
  if (!includeLedgers && ledgerIds.length > 0) {
    throw new ArchiveContractError('archive_erasure_request_invalid');
  }
  if (body.includeRegistered !== undefined && typeof body.includeRegistered !== 'boolean') {
    throw new ArchiveContractError('archive_erasure_request_invalid');
  }
  if (
    body.registeredCursor !== undefined &&
    (typeof body.registeredCursor !== 'string' || !/^[a-f0-9]{64}$/u.test(body.registeredCursor))
  ) {
    throw new ArchiveContractError('archive_erasure_request_invalid');
  }
  return {
    orgId: body.orgId,
    ledgerIds: [...new Set(ledgerIds as string[])],
    includeRegistered: includeLedgers && body.includeRegistered === true,
    ...(typeof body.registeredCursor === 'string'
      ? { registeredCursor: body.registeredCursor }
      : {}),
  };
}

function erasureFailure(c: Context<{ Bindings: ArchiveApiEnv }>, error: unknown): Response {
  const reason =
    error instanceof ArchiveContractError ? error.errorClass : 'archive_erasure_failed';
  console.error(
    JSON.stringify({
      event: 'archive_api.erasure_failed',
      errorClass: error instanceof Error ? error.name : 'unknown_error',
      reason,
    }),
  );
  return c.json({ error: 'archive_erasure_failed', reason }, 503);
}

export async function handleBeginArchiveErasure(
  c: Context<{ Bindings: ArchiveApiEnv }>,
): Promise<Response> {
  const rejected = unauthorized(c);
  if (rejected) return rejected;
  try {
    const { orgId } = await parseErasureRequest(c, false);
    await c.env.STORAGE_BUDGET.getByName(orgId).beginArchiveErasure({ orgId });
    return c.json({ staged: true });
  } catch (error) {
    return erasureFailure(c, error);
  }
}

export async function handleEraseArchiveLedgers(
  c: Context<{ Bindings: ArchiveApiEnv }>,
): Promise<Response> {
  const rejected = unauthorized(c);
  if (rejected) return rejected;
  try {
    const body = await parseErasureRequest(c, true);
    const ledgerIds = new Map(body.ledgerIds.map((ledgerId) => [ledgerId, false]));
    let registeredPage: { ledgerIds: string[]; cursor?: string } | undefined;
    if (body.includeRegistered) {
      registeredPage = await c.env.STORAGE_BUDGET.getByName(body.orgId).listArchiveLedgers({
        orgId: body.orgId,
        cursor: body.registeredCursor,
        limit: MAX_LEDGER_IDS,
      });
      for (const ledgerId of registeredPage.ledgerIds) ledgerIds.set(ledgerId, true);
    }
    let erased = 0;
    for (const [ledgerId, trustedRegistered] of ledgerIds) {
      const id = c.env.ARCHIVE_SESSION_LEDGER.idFromString(ledgerId);
      const result = await c.env.ARCHIVE_SESSION_LEDGER.get(id).eraseArchive({
        orgId: body.orgId,
        trustedRegistered,
      });
      if (result.erased) erased += 1;
    }
    if (registeredPage) {
      await c.env.STORAGE_BUDGET.getByName(body.orgId).removeArchiveLedgers({
        orgId: body.orgId,
        ledgerIds: registeredPage.ledgerIds,
      });
    }
    return c.json({
      checked: ledgerIds.size,
      erased,
      ...(registeredPage?.cursor === undefined ? {} : { registeredCursor: registeredPage.cursor }),
    });
  } catch (error) {
    return erasureFailure(c, error);
  }
}

async function deleteArchiveObjectPage(env: ArchiveApiEnv, orgId: string): Promise<number> {
  const prefix = `${await archiveOrganizationPrefix(orgId)}/`;
  const page = await env.ARCHIVE_STORAGE.list({ prefix, limit: R2_DELETE_BATCH_SIZE });
  if (page.objects.length > 0) {
    await env.ARCHIVE_STORAGE.delete(page.objects.map((object) => object.key));
  }
  return page.objects.length;
}

export async function handleFinishArchiveErasure(
  c: Context<{ Bindings: ArchiveApiEnv }>,
): Promise<Response> {
  const rejected = unauthorized(c);
  if (rejected) return rejected;
  try {
    const { orgId } = await parseErasureRequest(c, false);
    const deletedObjects = await deleteArchiveObjectPage(c.env, orgId);
    if (deletedObjects === 0) {
      await c.env.STORAGE_BUDGET.getByName(orgId).finishArchiveErasure({ orgId });
    }
    return c.json({ erased: deletedObjects === 0, deletedObjects });
  } catch (error) {
    return erasureFailure(c, error);
  }
}
