import {
  AGENT_INGEST_LIMITS,
  validateAgentIngestQueueMessage,
  type AgentIngestQueueMessage,
} from '@trace-flow/types';
import { truncateUtf8Bytes, utf8ByteLength } from '@trace-flow/utils';

interface ExcerptChange {
  field: 'command_excerpt' | 'error_excerpt';
  index: number;
  beforeBytes: number;
  afterBytes: number;
}

export interface NormalizedExcerptRepair {
  body: AgentIngestQueueMessage;
  changes: ExcerptChange[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeDlqExcerptByteLimits(body: unknown): NormalizedExcerptRepair {
  const originalError = validateAgentIngestQueueMessage(body);
  if (!originalError) throw new Error('DLQ payload already satisfies the agent queue contract');
  if (!isRecord(body) || !isRecord(body.facts) || !Array.isArray(body.facts.tool_events)) {
    throw new Error('DLQ payload has no repairable tool events');
  }

  const corrected = structuredClone(body);
  const facts = corrected.facts as Record<string, unknown>;
  const tools = facts.tool_events as unknown[];
  const changes: ExcerptChange[] = [];

  for (const [index, value] of tools.entries()) {
    if (!isRecord(value)) continue;
    for (const [field, maxBytes] of [
      ['command_excerpt', AGENT_INGEST_LIMITS.maxCommandExcerptBytes],
      ['error_excerpt', AGENT_INGEST_LIMITS.maxErrorExcerptBytes],
    ] as const) {
      const excerpt = value[field];
      if (typeof excerpt !== 'string') continue;
      const beforeBytes = utf8ByteLength(excerpt);
      if (beforeBytes <= maxBytes) continue;
      const normalized = truncateUtf8Bytes(excerpt, maxBytes);
      value[field] = normalized;
      changes.push({
        field,
        index,
        beforeBytes,
        afterBytes: utf8ByteLength(normalized),
      });
    }
  }

  if (changes.length === 0) throw new Error('DLQ payload has no overlong command or error excerpt');
  const remainingError = validateAgentIngestQueueMessage(corrected);
  if (remainingError) {
    throw new Error(`DLQ payload remains invalid after excerpt repair at ${remainingError}`);
  }
  return { body: corrected as unknown as AgentIngestQueueMessage, changes };
}
