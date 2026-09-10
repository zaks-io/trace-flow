import { CATEGORIES, emptyAccumulator, type Accumulator } from './facts';

export const AGENT_FACT_RPC_MAX_ROWS = 500;
const AGENT_FACT_RPC_MAX_BYTES = 900_000;

export interface AgentFactRpcBatch {
  rows: Accumulator;
  writeClean: boolean;
  writeLegacy: boolean;
}

export interface AgentFactRpcBatchLimits {
  maxRows?: number;
  maxBytes?: number;
}

const encoder = new TextEncoder();

export function agentFactRpcBatchBytes(batch: AgentFactRpcBatch): number {
  return encoder.encode(JSON.stringify(batch)).byteLength;
}

/**
 * Keeps each RPC below the batcher's existing 900 KB payload unit and bounds the synchronous SQL
 * loop. Category and row traversal order stay stable so retries produce identical chunks.
 */
export function chunkAgentFactRpcBatches(
  rows: Accumulator,
  writeClean: boolean,
  writeLegacy: boolean,
  limits: AgentFactRpcBatchLimits = {},
): AgentFactRpcBatch[] {
  const maxRows = limits.maxRows ?? AGENT_FACT_RPC_MAX_ROWS;
  const maxBytes = limits.maxBytes ?? AGENT_FACT_RPC_MAX_BYTES;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1)
    throw new Error('RPC row limit must be positive');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('RPC byte limit must be positive');

  const batches: AgentFactRpcBatch[] = [];
  let current = makeBatch(writeClean, writeLegacy);
  let currentRows = 0;
  let currentBytes = agentFactRpcBatchBytes(current);
  if (currentBytes > maxBytes) throw new Error('RPC byte limit cannot fit an empty fact batch');

  const flush = (): void => {
    if (currentRows === 0) return;
    batches.push(current);
    current = makeBatch(writeClean, writeLegacy);
    currentRows = 0;
    currentBytes = agentFactRpcBatchBytes(current);
  };

  for (const category of CATEGORIES) {
    for (const row of rows[category]) {
      const serialized = JSON.stringify(row);
      if (serialized === undefined) throw new Error(`RPC ${category} row is not JSON serializable`);
      const rowBytes = encoder.encode(serialized).byteLength;
      let addedBytes = rowBytes + (current.rows[category].length > 0 ? 1 : 0);
      if (currentRows > 0 && (currentRows + 1 > maxRows || currentBytes + addedBytes > maxBytes)) {
        flush();
        addedBytes = rowBytes;
      }
      if (currentBytes + addedBytes > maxBytes) {
        throw new Error(`RPC ${category} row exceeds the ${maxBytes}-byte batch limit`);
      }
      current.rows[category].push(row);
      currentRows++;
      currentBytes += addedBytes;
    }
  }

  flush();
  return batches;
}

function makeBatch(writeClean: boolean, writeLegacy: boolean): AgentFactRpcBatch {
  return { rows: emptyAccumulator(), writeClean, writeLegacy };
}
