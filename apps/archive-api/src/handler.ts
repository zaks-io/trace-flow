import type { Context } from 'hono';
import { axiomConfigFromEnv, createWorkerLogger } from '@trace-flow/logging';
import { authenticateCollectorCredential } from '@trace-flow/utils';
import type { ArchiveApiEnv } from './context';
import { authorizeArchiveUpload, isArchiveSupportedSource } from './enrollment';
import {
  ARCHIVE_EXPORT_GRANT_HEADER,
  authenticateArchiveExportGrant,
  hasForeignCredentialClass,
} from './export-grant';

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
      const status = decision.reason === 'policy_unavailable' ? 503 : 403;
      return c.json({ error: 'forbidden', reason: decision.reason }, status);
    }

    logger.info('archive_api.upload_authorized', {
      enrollmentId: decision.enrollmentId,
      contributionId: decision.contributionId,
    });
    return c.json({ error: 'persistence_not_implemented' }, 501);
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
