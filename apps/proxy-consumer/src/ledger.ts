import {
  IMPORTED_EXECUTION,
  SOURCE_IMPORTED_EXECUTION,
  TRACE_FLOW,
} from '@trace-flow/otel-conventions';
import type { OTLPQueueMessage, TinybirdTrace } from '@trace-flow/types';

interface LedgerEntry {
  key: string;
  hash: string;
  contract?: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function traceLedgerEntry(
  trace: TinybirdTrace,
  importedExecution?: OTLPQueueMessage['importedExecution'],
): LedgerEntry {
  const attributes = trace.SpanAttributes;
  const markedImported = attributes[TRACE_FLOW.SOURCE] === SOURCE_IMPORTED_EXECUTION;
  if (Boolean(importedExecution) !== markedImported) {
    throw new Error('Imported execution ledger metadata is incomplete');
  }
  if (markedImported) {
    const identity = attributes[TRACE_FLOW.IMPORT_IDENTITY];
    const hash = attributes[TRACE_FLOW.IMPORT_SOURCE_HASH];
    if (
      importedExecution?.contract !== IMPORTED_EXECUTION.CONTRACT ||
      !importedExecution.orgId ||
      !identity ||
      !SHA256_HEX.test(identity) ||
      !hash ||
      !SHA256_HEX.test(hash)
    ) {
      throw new Error('Imported execution ledger fields are invalid');
    }
    return {
      key: `imported_execution\x1f${identity}`,
      hash,
      contract: IMPORTED_EXECUTION.CONTRACT,
    };
  }
  return {
    key: [trace.ApiKey, trace.TraceId, trace.SpanId].join('\x1f'),
    hash: stableHash(trace),
  };
}

function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, '0');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
