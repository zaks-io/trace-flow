import { describe, expect, it } from 'vitest';
import {
  GEN_AI_USAGE,
  IMPORTED_EXECUTION,
  SOURCE_IMPORTED_EXECUTION,
  TRACE_FLOW,
} from '@trace-flow/otel-conventions';
import { selectImportedScope } from '../imported/selection';
import type { OTLPExportTraceServiceRequest } from '../types';

function body(scope?: { name?: string; version?: string }): OTLPExportTraceServiceRequest {
  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            scope,
            spans: [
              {
                traceId: '1'.repeat(32),
                spanId: '2'.repeat(16),
                name: 'chat model',
                startTimeUnixNano: '1',
                endTimeUnixNano: '2',
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('imported scope selection', () => {
  it('keeps unrelated OTLP exports on the generic path', () => {
    const generic = body({ name: 'other.instrumentation', version: '5' });
    generic.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes = [
      { key: 'customer.attribute', value: { stringValue: 'value' } },
      ...[
        GEN_AI_USAGE.SCHEMA_VERSION,
        GEN_AI_USAGE.QUALITY,
        GEN_AI_USAGE.TOTAL_TOKENS,
        GEN_AI_USAGE.OUTPUT_TOKENS_NON_REASONING,
        GEN_AI_USAGE.UNCLASSIFIED_TOKENS,
        GEN_AI_USAGE.MISSING,
      ].map((key) => ({ key, value: { stringValue: 'generic-value' } })),
    ];
    expect(selectImportedScope(generic)).toEqual({ kind: 'generic' });
  });

  it('selects the versioned execution contract', () => {
    expect(
      selectImportedScope(
        body({ name: IMPORTED_EXECUTION.SCOPE_NAME, version: IMPORTED_EXECUTION.SCOPE_VERSION }),
      ),
    ).toEqual({ kind: 'imported' });
  });

  it('rejects an unsupported contract version and mixed scopes', () => {
    expect(
      selectImportedScope(body({ name: IMPORTED_EXECUTION.SCOPE_NAME, version: '3' })),
    ).toEqual({ kind: 'invalid', reason: 'unsupported_version' });
    const mixed = body({
      name: IMPORTED_EXECUTION.SCOPE_NAME,
      version: IMPORTED_EXECUTION.SCOPE_VERSION,
    });
    mixed.resourceSpans[0]!.scopeSpans.push(body().resourceSpans[0]!.scopeSpans[0]!);
    expect(selectImportedScope(mixed)).toEqual({ kind: 'invalid', reason: 'mixed_scopes' });
  });

  it('rejects forged server stamps on the generic path', () => {
    const generic = body();
    const span = generic.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    span.attributes = [{ key: TRACE_FLOW.COST_STATUS, value: { stringValue: 'priced' } }];
    expect(selectImportedScope(generic)).toEqual({ kind: 'invalid', reason: 'reserved_attribute' });
    span.attributes = [{ key: TRACE_FLOW.IMPORT_IDENTITY, value: { stringValue: 'forged' } }];
    expect(selectImportedScope(generic)).toEqual({ kind: 'invalid', reason: 'reserved_attribute' });
    span.attributes = [
      { key: TRACE_FLOW.SOURCE, value: { stringValue: SOURCE_IMPORTED_EXECUTION } },
    ];
    expect(selectImportedScope(generic)).toEqual({ kind: 'invalid', reason: 'reserved_attribute' });
  });
});
