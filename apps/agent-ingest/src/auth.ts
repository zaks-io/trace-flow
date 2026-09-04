import type { Logger } from '@trace-flow/logging';
import { authenticateCollectorCredential, type CollectorAuthResult } from '@trace-flow/utils';

/**
 * Agent Ingest Collector Credential gate. Implementation lives in `@trace-flow/utils` so Archive
 * API can share the same KV contract; this wrapper only supplies the ingest logger prefix.
 */
export async function authenticateCollector(
  env: { COLLECTOR_CREDS: KVNamespace },
  secret: string | undefined,
  logger: Logger,
): Promise<CollectorAuthResult> {
  return authenticateCollectorCredential(env.COLLECTOR_CREDS, secret, logger, 'agent_ingest');
}
