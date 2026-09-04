import type { Context } from 'hono';
import { axiomConfigFromEnv, createWorkerLogger } from '@trace-flow/logging';
import { authenticateCollectorCredential } from '@trace-flow/utils';
import type { ArchiveApiEnv } from './context';
import { ArchiveContractError, assertIdentifier } from './archive-contract';
import { assertIncomingObservationCount, parseAndValidateUpload } from './archive-validation';
import {
  assertArchiveWriteIdentity,
  authorizeArchiveUpload,
  getArchiveWrappedKey,
  isArchiveSupportedSource,
} from './enrollment';
import {
  ARCHIVE_EXPORT_GRANT_HEADER,
  authenticateArchiveExportGrant,
  hasForeignCredentialClass,
} from './export-grant';
import { MAX_ARCHIVE_UPLOAD_BYTES, readBoundedJson } from './archive-request';
import { statusFor } from './archive-ledger-support';

const COLLECTOR_SECRET_HEADER = 'X-Trace-Flow-Collector-Secret';
const ARCHIVE_SOURCE_HEADER = 'X-Trace-Flow-Archive-Source';

function requestLogger(c: Context<{ Bindings: ArchiveApiEnv }>, operation: string) {
  return createWorkerLogger({
    service: 'archive-api',
    request: c.req.raw,
    axiom: axiomConfigFromEnv(c.env),
    context: { component: 'http', operation },
  });
}

export function handleHealthz(c: Context<{ Bindings: ArchiveApiEnv }>): Response {
  return c.json({ status: 'ok' });
}

export async function handleUpload(c: Context<{ Bindings: ArchiveApiEnv }>): Promise<Response> {
  const logger = requestLogger(c, 'archive_upload');
  try {
    if (hasForeignCredentialClass(c.req.header('Authorization'), c.req.header('Cookie'))) {
      logger.warn('archive_api.auth_rejected', { reason: 'invalid_credential_class' });
      return c.json({ error: 'unauthorized', reason: 'invalid_credential_class' }, 401);
    }

    const auth = await authenticateCollectorCredential(
      c.env.COLLECTOR_CREDS,
      c.req.header(COLLECTOR_SECRET_HEADER),
      logger,
      'archive_api',
    );
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    try {
      assertIdentifier(auth.credential.orgId, 'invalid_auth_identity');
      assertIdentifier(auth.credential.userId, 'invalid_auth_identity');
      assertIdentifier(auth.credential.collectorId, 'invalid_auth_identity');
      assertIdentifier(auth.credential.collectorCredentialId, 'invalid_auth_identity');
    } catch (error) {
      if (!(error instanceof ArchiveContractError)) throw error;
      logger.error('archive_api.auth_cred_corrupt', undefined, { reason: 'invalid_identity' });
      return c.json({ error: 'unauthorized', reason: 'invalid' }, 401);
    }

    const source = c.req.header(ARCHIVE_SOURCE_HEADER);
    if (!isArchiveSupportedSource(source)) {
      logger.warn('archive_api.invalid_source');
      return c.json({ error: 'invalid_source' }, 400);
    }

    const decision = await authorizeArchiveUpload(
      c.env,
      {
        hashedSecret: auth.credential.collectorCredentialId,
        source,
        orgId: auth.credential.orgId,
        userId: auth.credential.userId,
        collectorId: auth.credential.collectorId,
      },
      logger,
    );
    if (!decision.allowed) {
      logger.warn('archive_api.policy_denied', {
        reason: decision.reason,
        source,
        orgId: auth.credential.orgId,
        userId: auth.credential.userId,
        collectorId: auth.credential.collectorId,
      });
      const status = decision.reason === 'policy_unavailable' ? 503 : 403;
      return c.json({ error: 'forbidden', reason: decision.reason }, status);
    }

    if (
      decision.orgId !== auth.credential.orgId ||
      decision.userId !== auth.credential.userId ||
      decision.collectorId !== auth.credential.collectorId
    ) {
      logger.warn('archive_api.policy_tenancy_mismatch', { source });
      return c.json({ error: 'forbidden', reason: 'policy_mismatch' }, 403);
    }
    try {
      assertArchiveWriteIdentity(decision);
    } catch (error) {
      if (!(error instanceof ArchiveContractError)) throw error;
      logger.error('archive_api.policy_malformed', undefined, { reason: 'invalid_identity' });
      return c.json({ error: 'archive_unavailable', reason: 'policy_malformed' }, 503);
    }

    let upload: unknown;
    try {
      upload = await readBoundedJson(c.req.raw, MAX_ARCHIVE_UPLOAD_BYTES, 'upload_too_large');
    } catch (error) {
      const tooLarge =
        error instanceof ArchiveContractError && error.errorClass === 'upload_too_large';
      logger.warn('archive_api.invalid_upload', {
        reason: tooLarge ? 'upload_too_large' : 'invalid_json',
      });
      return c.json(
        { error: tooLarge ? 'upload_too_large' : 'invalid_upload' },
        tooLarge ? 413 : 400,
      );
    }
    if (
      typeof upload !== 'object' ||
      upload === null ||
      Array.isArray(upload) ||
      typeof (upload as Record<string, unknown>).source_session_id !== 'string'
    ) {
      logger.warn('archive_api.invalid_upload', { reason: 'invalid_shape' });
      return c.json({ error: 'invalid_upload' }, 400);
    }
    const sourceSessionId = (upload as Record<string, unknown>).source_session_id as string;
    try {
      assertIdentifier(sourceSessionId, 'invalid_source_session_id');
      assertIncomingObservationCount(upload);
    } catch (error) {
      if (
        !(error instanceof ArchiveContractError) ||
        (error.errorClass !== 'invalid_source_session_id' &&
          error.errorClass !== 'archive_upload_observation_limit')
      ) {
        throw error;
      }
      logger.warn('archive_api.invalid_upload', { reason: error.errorClass });
      if (error.errorClass === 'archive_upload_observation_limit') {
        return c.json({ error: 'upload_too_large' }, 413);
      }
      return c.json({ error: 'invalid_upload' }, 400);
    }

    const currentDecision = await authorizeArchiveUpload(
      c.env,
      {
        hashedSecret: auth.credential.collectorCredentialId,
        source,
        orgId: auth.credential.orgId,
        userId: auth.credential.userId,
        collectorId: auth.credential.collectorId,
      },
      logger,
    );
    if (!currentDecision.allowed) {
      logger.warn('archive_api.policy_denied', {
        reason: currentDecision.reason,
        source,
        orgId: auth.credential.orgId,
        userId: auth.credential.userId,
        collectorId: auth.credential.collectorId,
      });
      const status = currentDecision.reason === 'policy_unavailable' ? 503 : 403;
      return c.json({ error: 'forbidden', reason: currentDecision.reason }, status);
    }
    if (
      currentDecision.orgId !== auth.credential.orgId ||
      currentDecision.userId !== auth.credential.userId ||
      currentDecision.collectorId !== auth.credential.collectorId
    ) {
      logger.warn('archive_api.policy_tenancy_mismatch', { source });
      return c.json({ error: 'forbidden', reason: 'policy_mismatch' }, 403);
    }
    try {
      assertArchiveWriteIdentity(currentDecision);
    } catch (error) {
      if (!(error instanceof ArchiveContractError)) throw error;
      logger.error('archive_api.policy_malformed', undefined, { reason: 'invalid_identity' });
      return c.json({ error: 'archive_unavailable', reason: 'policy_malformed' }, 503);
    }

    try {
      await parseAndValidateUpload(upload, {
        orgId: currentDecision.orgId,
        userId: currentDecision.userId,
        contributionId: currentDecision.contributionId,
        source,
        sourceSessionId,
      });
    } catch (error) {
      if (!(error instanceof ArchiveContractError)) throw error;
      logger.warn('archive_api.invalid_upload', { reason: error.errorClass });
      return new Response(JSON.stringify({ error: 'upload_rejected', reason: error.errorClass }), {
        status: statusFor(error.errorClass),
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const keyVersion = Number(c.env.ARCHIVE_KEY_VERSION);
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
      logger.error('archive_api.key_configuration_invalid');
      return c.json({ error: 'archive_unavailable', reason: 'key_configuration_invalid' }, 503);
    }
    let wrappedKey: Awaited<ReturnType<typeof getArchiveWrappedKey>>;
    try {
      wrappedKey = await getArchiveWrappedKey(c.env, { orgId: decision.orgId, keyVersion }, logger);
    } catch {
      return c.json({ error: 'archive_unavailable', reason: 'key_unavailable' }, 503);
    }

    const ledgerId = c.env.ARCHIVE_SESSION_LEDGER.idFromName(
      JSON.stringify([
        currentDecision.orgId,
        currentDecision.contributionId,
        source,
        sourceSessionId,
      ]),
    );
    const ledgerResponse = await c.env.ARCHIVE_SESSION_LEDGER.get(ledgerId).fetch(
      'https://archive-session-ledger/commit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: {
            orgId: currentDecision.orgId,
            userId: currentDecision.userId,
            contributionId: currentDecision.contributionId,
            source,
            sourceSessionId,
          },
          upload,
          keyVersion: wrappedKey.keyVersion,
          wrappedKey: wrappedKey.wrappedKey,
        }),
      },
    );
    const responseBody = await ledgerResponse.text();
    if (!ledgerResponse.ok) {
      let reason = 'archive_commit_failed';
      try {
        const parsed = JSON.parse(responseBody) as { error?: unknown };
        if (typeof parsed.error === 'string') reason = parsed.error;
      } catch {
        // The ledger response is not part of the client contract when malformed.
      }
      logger.warn('archive_api.upload_rejected', { reason, source });
      return new Response(JSON.stringify({ error: 'upload_rejected', reason }), {
        status: ledgerResponse.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    logger.info('archive_api.upload_authorized', {
      enrollmentId: currentDecision.enrollmentId,
      contributionId: currentDecision.contributionId,
    });
    return new Response(responseBody, {
      status: ledgerResponse.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    c.executionCtx.waitUntil(logger.flush());
  }
}

function rejectWithoutExportGrant(
  c: Context<{ Bindings: ArchiveApiEnv }>,
  operation: string,
): Response {
  const logger = requestLogger(c, operation);
  const grant = authenticateArchiveExportGrant(
    c.req.header(ARCHIVE_EXPORT_GRANT_HEADER),
    c.req.header('Authorization'),
    c.req.header('Cookie'),
  );
  logger.warn('archive_api.export_grant_rejected', { reason: grant.reason });
  c.executionCtx.waitUntil(logger.flush());
  const status =
    grant.reason === 'missing' || grant.reason === 'invalid_credential_class' ? 401 : 403;
  return c.json({ error: 'unauthorized', reason: grant.reason }, status);
}

export function handleExport(c: Context<{ Bindings: ArchiveApiEnv }>): Response {
  return rejectWithoutExportGrant(c, 'archive_export');
}

export function handleDeleteContribution(c: Context<{ Bindings: ArchiveApiEnv }>): Response {
  return rejectWithoutExportGrant(c, 'archive_delete_contribution');
}

export function handleDeleteArchive(c: Context<{ Bindings: ArchiveApiEnv }>): Response {
  return rejectWithoutExportGrant(c, 'archive_delete');
}
