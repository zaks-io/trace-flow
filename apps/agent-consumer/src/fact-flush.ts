import * as Sentry from '@sentry/cloudflare';
import type { createLogger } from '@trace-flow/logging';
import type { AgentConsumerEnv } from './context';
import { CATEGORIES, emptyAccumulator, rowOrgId, type Accumulator } from './facts';
import { chunkAgentFactRpcBatches } from './fact-rpc-batches';

type Logger = ReturnType<typeof createLogger>;
type WriteMode = 'clean' | 'legacy' | 'dual';
const MAX_CONCURRENT_ORG_RPCS = 6;

export async function flushFacts(
  rows: Accumulator,
  env: AgentConsumerEnv,
  logger: Logger,
): Promise<boolean> {
  const failedOrgIds = await flushRowsByOrg(groupRowsByOrg(rows), env, logger);
  return failedOrgIds.size === 0;
}

export async function flushRowsByOrg(
  byOrg: Map<string, Accumulator>,
  env: AgentConsumerEnv,
  logger: Logger,
): Promise<Set<string>> {
  const mode = writeMode(env);
  const writeClean = mode !== 'legacy';
  const writeLegacy = mode !== 'clean';
  const entries = [...byOrg.entries()];
  const results: (string | null)[] = [];
  for (let offset = 0; offset < entries.length; offset += MAX_CONCURRENT_ORG_RPCS) {
    const group = entries.slice(offset, offset + MAX_CONCURRENT_ORG_RPCS);
    const groupResults = await Promise.all(
      group.map(async ([orgId, rows]) => {
        try {
          const batcher = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
          const chunks = chunkAgentFactRpcBatches(rows, writeClean, writeLegacy);
          for (const chunk of chunks) {
            const result = await batcher.addFacts(chunk);
            if (result.status === 'failed') {
              throw new Error(`agent fact batcher rejected org ${orgId}`);
            }
            if (result.repairRows > 0) {
              logger.warn('agent_consumer.repair_rows_detected', {
                orgId,
                repairRows: result.repairRows,
              });
            }
            if (result.blockedRecoveryRecords > 0) {
              logger.warn('agent_consumer.blocked_recovery_rows', {
                orgId,
                blockedRecoveryRows: result.blockedRecoveryRows,
                blockedRecoveryRecords: result.blockedRecoveryRecords,
              });
            }
          }
          return null;
        } catch (error) {
          logger.error('agent_consumer.fact_batcher_failed', error, { orgId });
          Sentry.captureException(error, {
            tags: { operation: 'agent_fact_batcher', org_id: orgId },
          });
          return orgId;
        }
      }),
    );
    results.push(...groupResults);
  }

  return new Set(results.filter((orgId): orgId is string => orgId !== null));
}

function groupRowsByOrg(rows: Accumulator): Map<string, Accumulator> {
  const byOrg = new Map<string, Accumulator>();
  for (const category of CATEGORIES) {
    for (const row of rows[category]) {
      const orgId = rowOrgId(row);
      if (!orgId) continue;
      let orgRows = byOrg.get(orgId);
      if (!orgRows) {
        orgRows = emptyAccumulator();
        byOrg.set(orgId, orgRows);
      }
      orgRows[category].push(row);
    }
  }
  return byOrg;
}

function writeMode(env: AgentConsumerEnv): WriteMode {
  const mode = env.TINYBIRD_AGENT_WRITE_MODE ?? 'clean';
  if (mode === 'clean' || mode === 'legacy' || mode === 'dual') return mode;
  throw new Error(`invalid TINYBIRD_AGENT_WRITE_MODE: ${mode}`);
}
