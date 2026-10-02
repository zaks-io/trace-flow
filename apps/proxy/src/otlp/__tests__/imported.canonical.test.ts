import { describe, expect, it } from 'vitest';
import { importedExecutionIdentity, importedExecutionSourceHash } from '../imported/canonical';
import type { OTLPSpan } from '../types';

const SPAN: OTLPSpan = {
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  name: 'chat model',
  startTimeUnixNano: '1000000000',
  endTimeUnixNano: '2000000000',
  status: { code: 1 },
};

describe('imported execution identity and source hash', () => {
  it('uses authenticated organization, installation, and execution identity', async () => {
    const first = await importedExecutionIdentity('org-a', 'installation', 'execution');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await importedExecutionIdentity('org-a', 'installation', 'execution')).toBe(first);
    expect(await importedExecutionIdentity('org-b', 'installation', 'execution')).not.toBe(first);
    expect(await importedExecutionIdentity('org-a', 'installation', 'other')).not.toBe(first);
    await expect(importedExecutionIdentity('', 'installation', 'execution')).rejects.toThrow();
  });

  it('normalizes transport order, integer spelling, and OTel hex case', async () => {
    const first = await importedExecutionSourceHash('installation', 'execution', SPAN, {
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'model',
    });
    const replay = await importedExecutionSourceHash(
      'installation',
      'execution',
      { ...SPAN, traceId: SPAN.traceId.toUpperCase(), startTimeUnixNano: '01000000000' },
      { 'gen_ai.request.model': 'model', 'gen_ai.system': 'openai' },
    );
    expect(replay).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes on source facts but has no arrival or catalog input', async () => {
    const first = await importedExecutionSourceHash('installation', 'execution', SPAN, {
      'gen_ai.usage.output_tokens': '42',
    });
    expect(
      await importedExecutionSourceHash('installation', 'execution', SPAN, {
        'gen_ai.usage.output_tokens': '43',
      }),
    ).not.toBe(first);
    expect(
      await importedExecutionSourceHash(
        'installation',
        'execution',
        { ...SPAN, spanId: 'c'.repeat(16) },
        {
          'gen_ai.usage.output_tokens': '42',
        },
      ),
    ).not.toBe(first);
  });
});
