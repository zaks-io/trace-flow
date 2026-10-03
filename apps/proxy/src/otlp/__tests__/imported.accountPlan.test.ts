import { describe, expect, it } from 'vitest';
import { CLI_PROXY, IMPORTED_ACCOUNT_PLANS } from '@trace-flow/otel-conventions';
import fixture from '../../../../../fixtures/cliproxyapi-execution-v2.json';
import { buildImportedExecutionTraces } from '../imported/traces';
import { validateImportedExecutionRequest } from '../imported/validate';
import type { OTLPAnyValue, OTLPExportTraceServiceRequest } from '../types';

const PROVIDER_ACCOUNT_SPAN = 0;
const CREDENTIAL_SPAN = 1;
const UNKNOWN_COVERAGE_SPAN = 2;
const NATIVE_CODEX_SPAN = 5;

function withPlan(spanIndex: number, value: OTLPAnyValue): OTLPExportTraceServiceRequest {
  const request: OTLPExportTraceServiceRequest = structuredClone(fixture);
  request.resourceSpans[0]!.scopeSpans[0]!.spans[spanIndex]!.attributes!.push({
    key: CLI_PROXY.ACCOUNT_PLAN,
    value,
  });
  return request;
}

function acceptedPlan(request: OTLPExportTraceServiceRequest, spanIndex: number) {
  const result = validateImportedExecutionRequest(request);
  if (!result.valid) throw new Error(`Expected a valid export, got ${result.reason}`);
  return result.executions[spanIndex]!.attributes[CLI_PROXY.ACCOUNT_PLAN];
}

describe('CLIProxyAPI account plan attribute', () => {
  it.each(IMPORTED_ACCOUNT_PLANS)('accepts %s on a provider account', (plan) => {
    const request = withPlan(PROVIDER_ACCOUNT_SPAN, { stringValue: plan });
    expect(acceptedPlan(request, PROVIDER_ACCOUNT_SPAN)).toBe(plan);
  });

  it('accepts a plan on credential coverage', () => {
    const request = withPlan(CREDENTIAL_SPAN, { stringValue: 'claude_max_20x' });
    expect(acceptedPlan(request, CREDENTIAL_SPAN)).toBe('claude_max_20x');
  });

  it('stores the shared fixture plan on its span and leaves other spans without one', async () => {
    const result = validateImportedExecutionRequest(structuredClone(fixture));
    if (!result.valid) throw new Error(`Expected a valid export, got ${result.reason}`);
    const traces = await buildImportedExecutionTraces(result.executions, 'key', 'org', 1);
    expect(traces.map((trace) => trace.SpanAttributes[CLI_PROXY.ACCOUNT_PLAN])).toEqual(
      traces.map((_, index) => (index === NATIVE_CODEX_SPAN ? 'chatgpt_pro' : undefined)),
    );
  });

  it('keeps the plan absent when the exporter omits it', () => {
    expect(acceptedPlan(structuredClone(fixture), PROVIDER_ACCOUNT_SPAN)).toBeUndefined();
  });

  it.each(['team', 'Claude_Pro', 'claude_max', 'chatgpt_plus ', ''])(
    'rejects the value %j outside the closed set',
    (plan) => {
      const request = withPlan(PROVIDER_ACCOUNT_SPAN, { stringValue: plan });
      expect(validateImportedExecutionRequest(request)).toEqual({
        valid: false,
        reason: 'attribute_string',
        spanIndex: PROVIDER_ACCOUNT_SPAN + 1,
      });
    },
  );

  it('rejects a non-string plan', () => {
    const request = withPlan(PROVIDER_ACCOUNT_SPAN, { intValue: '1' });
    expect(validateImportedExecutionRequest(request)).toMatchObject({
      valid: false,
      reason: 'attribute_value_type',
    });
  });

  it('rejects a plan when account coverage is unknown', () => {
    const request = withPlan(UNKNOWN_COVERAGE_SPAN, { stringValue: 'unknown' });
    expect(validateImportedExecutionRequest(request)).toEqual({
      valid: false,
      reason: 'attribute_account_plan',
      spanIndex: UNKNOWN_COVERAGE_SPAN + 1,
    });
  });
});
