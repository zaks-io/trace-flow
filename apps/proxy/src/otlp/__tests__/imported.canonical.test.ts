import { describe, expect, it } from 'vitest';
import { importedExecutionIdentity, importedExecutionSourceHash } from '../imported/canonical';
import type { OTLPSpan } from '../types';
import fixture from '../../../../../fixtures/cliproxyapi-execution-v2.json';
import { validateImportedExecutionRequest } from '../imported/validate';
import { CLI_PROXY } from '@trace-flow/otel-conventions';

const SPAN: OTLPSpan = {
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  name: 'chat model',
  startTimeUnixNano: '1000000000',
  endTimeUnixNano: '2000000000',
  status: { code: 1 },
};

describe('imported execution identity and source hash', () => {
  it('keeps the five legacy hashes unchanged and hashes native identity into replay conflicts', async () => {
    const result = validateImportedExecutionRequest(structuredClone(fixture));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const hashes = await Promise.all(
      result.executions.map((execution) =>
        importedExecutionSourceHash(
          execution.installationId,
          execution.executionId,
          execution.span,
          execution.attributes,
        ),
      ),
    );
    expect(hashes).toEqual([
      'fd84539a59854e91bf987911835c7e59e1039d6938c5dc1e7be032a22f429e3b',
      '17c9b76b8edc89245595049bb3e7c41a15a821d55937f4687a8cdbc17ae69aa9',
      '4bff5ac99125e285449297caf60826d4c0ee311fb7d79a39b91c22015c093679',
      '8301ab63245f80222b4d217cd24da38f7a687e2fee15238279e7adc76bd1b231',
      '801270db6dac1f067d213cf2feb92241bcf7ebe801652aa070cfef41d10af22e',
      '9ef332ee7ffa9c6f7f5a3f4be3c5139f891bfc2d64c52116cdc799a985b7c8d0',
    ]);
    const native = result.executions[5]!;
    expect(
      await importedExecutionSourceHash(
        native.installationId,
        native.executionId,
        native.span,
        native.attributes,
      ),
    ).toBe(hashes[5]);
    expect(
      await importedExecutionSourceHash(native.installationId, native.executionId, native.span, {
        ...native.attributes,
        [CLI_PROXY.CLIENT_SESSION_ID]: 'another-thread',
      }),
    ).not.toBe(hashes[5]);
  });

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
