import type { Context } from 'hono';
import { axiomConfigFromEnv, createWorkerLogger } from '@trace-flow/logging';
import { authenticateCollectorCredential } from '@trace-flow/utils';
import { ArchiveContractError, assertIdentifier } from './archive-contract';
import { readBoundedJson } from './archive-request';
import type { ArchiveApiEnv } from './context';
import {
  COLLECTOR_ENROLLMENT_MAX_REQUEST_BYTES,
  CollectorEnrollmentConflictError,
  parseCollectorEnrollmentRequest,
  submitCollectorEnrollment,
} from './collector-enrollment';
import { hasForeignCredentialClass } from './export-grant';

const COLLECTOR_SECRET_HEADER = 'X-Trace-Flow-Collector-Secret';

export async function handleCollectorEnrollment(
  c: Context<{ Bindings: ArchiveApiEnv }>,
): Promise<Response> {
  const logger = createWorkerLogger({
    service: 'archive-api',
    request: c.req.raw,
    axiom: axiomConfigFromEnv(c.env),
    context: { component: 'http', operation: 'collector_enrollment' },
  });

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
      return c.json({ error: 'unauthorized', reason: 'invalid_auth_identity' }, 401);
    }

    let body: unknown;
    try {
      body = await readBoundedJson(
        c.req.raw,
        COLLECTOR_ENROLLMENT_MAX_REQUEST_BYTES,
        'invalid_request',
      );
    } catch {
      logger.warn('archive_api.collector_enrollment_request_invalid');
      return c.json({ error: 'invalid_request' }, 400);
    }
    const request = parseCollectorEnrollmentRequest(body);
    if (!request) {
      logger.warn('archive_api.collector_enrollment_request_invalid');
      return c.json({ error: 'invalid_request' }, 400);
    }

    try {
      const policy = await submitCollectorEnrollment(
        c.env,
        {
          ...request,
          hashedSecret: auth.credential.collectorCredentialId,
          orgId: auth.credential.orgId,
          userId: auth.credential.userId,
          collectorId: auth.credential.collectorId,
        },
        logger,
      );
      return c.json(policy);
    } catch (error) {
      if (error instanceof CollectorEnrollmentConflictError) {
        logger.warn('archive_api.collector_enrollment_conflict');
        return c.json({ error: 'consent_conflict' }, 409);
      }
      return c.json({ error: 'archive_unavailable', reason: 'policy_unavailable' }, 503);
    }
  } finally {
    c.executionCtx.waitUntil(logger.flush());
  }
}
