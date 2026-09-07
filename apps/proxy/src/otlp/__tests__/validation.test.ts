import { describe, expect, it } from 'vitest';
import type { OTLPExportTraceServiceRequest } from '../types';
import { validateOTLPRequest } from '../validation';

function requestWithValue(value: unknown): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'test.value', value }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'trace-id',
                spanId: 'span-id',
                name: 'test',
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

describe('validateOTLPRequest', () => {
  it('accepts and normalizes a numeric ProtoJSON intValue', () => {
    const request = requestWithValue({ intValue: 42 });

    expect(validateOTLPRequest(request)).toEqual({ valid: true });
    const typed = request as OTLPExportTraceServiceRequest;
    expect(typed.resourceSpans[0]!.resource!.attributes![0]!.value.intValue).toBe('42');
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe numeric intValue %s', (intValue) => {
    expect(validateOTLPRequest(requestWithValue({ intValue }))).toMatchObject({
      valid: false,
      status: 400,
    });
  });

  it('rejects a quoted value outside the signed int64 range', () => {
    expect(
      validateOTLPRequest(requestWithValue({ intValue: '9223372036854775808' })),
    ).toMatchObject({ valid: false, status: 400 });
  });

  it('accepts an empty AnyValue but rejects a missing KeyValue value', () => {
    expect(validateOTLPRequest(requestWithValue({}))).toEqual({ valid: true });
    expect(validateOTLPRequest(requestWithValue(undefined))).toMatchObject({
      valid: false,
      status: 400,
    });
  });
});
