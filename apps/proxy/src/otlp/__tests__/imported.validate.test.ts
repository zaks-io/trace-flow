import { describe, expect, it } from 'vitest';
import { CLI_PROXY, GEN_AI_USAGE } from '@trace-flow/otel-conventions';
import fixture from '../../../../../fixtures/cliproxyapi-execution-v2.json';
import { validateImportedExecutionRequest } from '../imported/validate';
import type { OTLPExportTraceServiceRequest, OTLPKeyValue } from '../types';

function body(): OTLPExportTraceServiceRequest {
  return structuredClone(fixture);
}

function firstSpan(request: OTLPExportTraceServiceRequest) {
  return request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
}

function attribute(request: OTLPExportTraceServiceRequest, key: string): OTLPKeyValue {
  const found = firstSpan(request).attributes?.find((value) => value.key === key);
  if (!found) throw new Error(`Fixture attribute missing: ${key}`);
  return found;
}

function requestWithFullMetadata() {
  return body().resourceSpans[0]!.scopeSpans[0]!.spans[4]!;
}

describe('CLIProxyAPI imported execution contract', () => {
  it('accepts complete, unclassified, inconsistent, missing, and failed usage fixtures', () => {
    const result = validateImportedExecutionRequest(body());
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.executions).toHaveLength(5);
    expect(result.executions[0]!.attributes[GEN_AI_USAGE.TOTAL_TOKENS]).toBe('23');
    expect(result.executions[3]!.attributes[GEN_AI_USAGE.MISSING]).toBe('true');
    expect(result.executions[3]!.attributes[GEN_AI_USAGE.TOTAL_TOKENS]).toBeUndefined();
    expect(result.executions[4]!.span.status?.code).toBe(2);
    expect(result.executions[4]!.attributes[GEN_AI_USAGE.TOTAL_TOKENS]).toBe('7');
    expect(requestWithFullMetadata().attributes).toHaveLength(26);
  });

  it.each(['9223372036854775808', '9223372036854775807'])(
    'rejects a timestamp %s outside the serialized Int64 range before acceptance',
    (timestamp) => {
      const request = body();
      firstSpan(request).startTimeUnixNano = timestamp;
      firstSpan(request).endTimeUnixNano = timestamp;
      expect(validateImportedExecutionRequest(request)).toMatchObject({
        valid: false,
        reason: 'timing',
      });
    },
  );

  it('normalizes uppercase UUID and integer spelling', () => {
    const request = body();
    attribute(request, CLI_PROXY.EXECUTION_ID).value.stringValue = attribute(
      request,
      CLI_PROXY.EXECUTION_ID,
    ).value.stringValue!.toUpperCase();
    attribute(request, GEN_AI_USAGE.TOTAL_TOKENS).value.intValue = '00023';
    const result = validateImportedExecutionRequest(request);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.executions[0]!.executionId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
    expect(result.executions[0]!.attributes[GEN_AI_USAGE.TOTAL_TOKENS]).toBe('23');
  });

  it.each([
    ['input sum', GEN_AI_USAGE.INPUT_TOKENS, '14', 'usage_input_invariant'],
    ['output sum', GEN_AI_USAGE.OUTPUT_TOKENS, '11', 'usage_output_invariant'],
    ['total sum', GEN_AI_USAGE.TOTAL_TOKENS, '24', 'usage_total_invariant'],
    ['count range', GEN_AI_USAGE.TOTAL_TOKENS, '4294967296', 'usage_count_range'],
  ])('rejects invalid %s', (_label, key, value, reason) => {
    const request = body();
    attribute(request, key).value.intValue = value;
    expect(validateImportedExecutionRequest(request)).toEqual({
      valid: false,
      reason,
      spanIndex: 1,
    });
  });

  it('rejects complete quality with unclassified tokens', () => {
    const request = body();
    attribute(request, GEN_AI_USAGE.UNCLASSIFIED_TOKENS).value.intValue = '1';
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'usage_total_invariant',
    });
    attribute(request, GEN_AI_USAGE.TOTAL_TOKENS).value.intValue = '24';
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'usage_complete_unclassified',
    });
  });

  it('rejects a mixed missing and present usage block', () => {
    const request = body();
    firstSpan(request).attributes!.push({ key: GEN_AI_USAGE.MISSING, value: { boolValue: true } });
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'usage_missing_mixed',
    });
  });

  it('rejects credential-shaped values in allowed metadata fields', () => {
    const request = body();
    attribute(request, 'gen_ai.request.model').value.stringValue = `sk-${'a'.repeat(30)}`;
    firstSpan(request).name = `sk-${'a'.repeat(30)}`;
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'attribute_sensitive',
    });
  });

  it('rejects raw emails even in an otherwise allowed model field', () => {
    const request = body();
    attribute(request, 'gen_ai.request.model').value.stringValue = 'isaac@example.com';
    firstSpan(request).name = 'isaac@example.com';
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'attribute_email',
    });
  });

  it('rejects unapproved payload fields, events, links, and status text', () => {
    const request = body();
    firstSpan(request).attributes!.push({ key: 'gen_ai.prompt', value: { stringValue: 'secret' } });
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'attribute_not_allowed',
    });
    firstSpan(request).attributes!.pop();
    firstSpan(request).events = [{ name: 'body', attributes: [] }];
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'span_shape',
    });
    firstSpan(request).events = [];
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'span_shape',
    });
    firstSpan(request).events = undefined;
    firstSpan(request).links = [];
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'span_shape',
    });
    firstSpan(request).links = undefined;
    firstSpan(request).status = { code: 2, message: 'failure body' };
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'status',
    });
  });

  it('rejects an OTel ID not derived from the execution UUID', () => {
    const request = body();
    firstSpan(request).spanId = 'b'.repeat(16);
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'otel_identity',
    });
  });

  it('allows backdated spans and rejects negative duration', () => {
    const request = body();
    firstSpan(request).startTimeUnixNano = '1000000000';
    firstSpan(request).endTimeUnixNano = '2000000000';
    expect(validateImportedExecutionRequest(request).valid).toBe(true);
    firstSpan(request).endTimeUnixNano = '999999999';
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'timing',
    });
  });
});
