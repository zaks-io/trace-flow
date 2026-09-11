import { describe, expect, it } from 'vitest';
import { AGENT_INGEST_LIMITS, validateAgentIngestQueueMessage } from '@trace-flow/types';
import { utf8ByteLength } from '@trace-flow/utils';
import { normalizeDlqExcerptByteLimits } from '../dlq-excerpt-repair';
import { emptyQueueFacts, queueMessage, toolEventFact } from './factories';

function messageWithTool(commandExcerpt: string, errorExcerpt: string) {
  return queueMessage({
    facts: {
      ...emptyQueueFacts(),
      tool_events: [
        toolEventFact({
          command_excerpt: commandExcerpt,
          error_excerpt: errorExcerpt,
        }),
      ],
    },
  });
}

describe('normalizeDlqExcerptByteLimits', () => {
  it('caps Unicode excerpts by UTF-8 bytes and preserves the original body', () => {
    const original = messageWithTool('é'.repeat(513), '😀'.repeat(1_025));
    const snapshot = structuredClone(original);

    const normalized = normalizeDlqExcerptByteLimits(original);
    const tool = normalized.body.facts.tool_events[0]!;

    expect(original).toEqual(snapshot);
    expect(validateAgentIngestQueueMessage(normalized.body)).toBeNull();
    expect(utf8ByteLength(tool.command_excerpt)).toBe(AGENT_INGEST_LIMITS.maxCommandExcerptBytes);
    expect(utf8ByteLength(tool.error_excerpt)).toBe(AGENT_INGEST_LIMITS.maxErrorExcerptBytes);
    expect(tool.command_excerpt).not.toContain('�');
    expect(tool.error_excerpt).not.toContain('�');
    expect(normalized.changes.map((change) => change.field)).toEqual([
      'command_excerpt',
      'error_excerpt',
    ]);
  });

  it('rejects a body that is already valid because no repair occurred', () => {
    expect(() => normalizeDlqExcerptByteLimits(messageWithTool('git status', ''))).toThrow(
      'already satisfies',
    );
  });

  it('rejects unrelated malformed fields even when an excerpt is repairable', () => {
    const malformed = messageWithTool('', '😀'.repeat(1_025)) as unknown as {
      facts: { tool_events: Record<string, unknown>[] };
    };
    malformed.facts.tool_events[0]!.status = 'not-a-status';

    expect(() => normalizeDlqExcerptByteLimits(malformed)).toThrow(
      'remains invalid after excerpt repair',
    );
  });

  it('rejects an invalid body with no overlong command or error excerpt', () => {
    const malformed = messageWithTool('', '') as unknown as Record<string, unknown>;
    malformed.type = 'not-agent';

    expect(() => normalizeDlqExcerptByteLimits(malformed)).toThrow('no overlong');
  });
});
