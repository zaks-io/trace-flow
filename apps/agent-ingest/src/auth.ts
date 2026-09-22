import type { Logger } from '@trace-flow/logging';
import { authenticateCollectorCredential, type CollectorAuthResult } from '@trace-flow/utils';

export async function authenticateCollector(
  env: { COLLECTOR_CREDS: KVNamespace },
  secret: string | undefined,
  logger: Logger,
): Promise<CollectorAuthResult> {
  return authenticateCollectorCredential(env.COLLECTOR_CREDS, secret, logger, 'agent_ingest');
}
