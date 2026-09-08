import type { Context } from 'hono';
import { axiomConfigFromEnv, createWorkerLogger } from '@trace-flow/logging';
import { authenticateCollectorCredential } from '@trace-flow/utils';
import { ArchiveContractError, assertIdentifier } from './archive-contract';
import { fetchCollectorArchivePolicy } from './collector-policy';
import type { ArchiveApiEnv } from './context';
import { hasForeignCredentialClass } from './export-grant';

const COLLECTOR_SECRET_HEADER = 'X-Trace-Flow-Collector-Secret';

export async function handleCollectorPolicy(
  c: Context<{ Bindings: ArchiveApiEnv }>,
): Promise<Response> {
  const logger = createWorkerLogger({
    service: 'archive-api',
    request: c.req.raw,
    axiom: axiomConfigFromEnv(c.env),
    context: { component: 'http', operation: 'collector_policy' },
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
      return c.json({ error: 'unauthorized', reason: 'invalid' }, 401);
    }

    try {
      const policy = await fetchCollectorArchivePolicy(
        c.env,
        {
          hashedSecret: auth.credential.collectorCredentialId,
          orgId: auth.credential.orgId,
          userId: auth.credential.userId,
          collectorId: auth.credential.collectorId,
        },
        logger,
      );
      return c.json(policy);
    } catch {
      return c.json({ error: 'archive_unavailable', reason: 'policy_unavailable' }, 503);
    }
  } finally {
    c.executionCtx.waitUntil(logger.flush());
  }
}
