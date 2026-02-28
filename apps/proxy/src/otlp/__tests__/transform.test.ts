import { describe, it, expect } from 'vitest';
import { transformOTLPToTraces } from '../transform';
import type { OTLPExportTraceServiceRequest } from '../types';

describe('transformOTLPToTraces', () => {
  const apiKey = 'test-api-key';
  const receivedAt = 1700000000000000000; // Test receivedAt in nanoseconds

  function getTrace(traces: ReturnType<typeof transformOTLPToTraces>, index: number) {
    const trace = traces[index];
    if (!trace) throw new Error(`No trace at index ${index}`);
    return trace;
  }

  it('should transform a simple OTLP request to TinybirdTrace', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'my-service' } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
                  spanId: '1234567890abcdef',
                  name: 'test-span',
                  kind: 3, // CLIENT
                  startTimeUnixNano: '1000000000000', // 1ms in nanoseconds
                  endTimeUnixNano: '2000000000000', // 2ms in nanoseconds
                  status: { code: 1, message: '' },
                },
              ],
            },
          ],
        },
      ],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      TraceId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      SpanId: '1234567890abcdef',
      ParentSpanId: '',
      SpanName: 'test-span',
      SpanKind: 'SPAN_KIND_CLIENT',
      ServiceName: 'my-service',
      StatusCode: 'STATUS_CODE_OK',
      ApiKey: apiKey,
    });
  });

  it('should keep timestamps in nanoseconds', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abcdef1234567890abcdef1234567890',
                  spanId: 'fedcba0987654321',
                  name: 'timing-test',
                  startTimeUnixNano: '1000000', // 1,000,000 nanoseconds
                  endTimeUnixNano: '2000000', // 2,000,000 nanoseconds
                },
              ],
            },
          ],
        },
      ],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);
    const trace = getTrace(traces, 0);

    expect(trace.Timestamp).toBe(1000000); // Stays in nanoseconds
    expect(trace.Duration).toBe(1000000); // Duration in nanoseconds
    expect(trace.ReceivedAt).toBe(receivedAt); // ReceivedAt is set
  });

  it('should transform span attributes to string record', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abcdef1234567890abcdef1234567890',
                  spanId: 'fedcba0987654321',
                  name: 'attr-test',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                  attributes: [
                    { key: 'http.method', value: { stringValue: 'POST' } },
                    { key: 'http.status_code', value: { intValue: '200' } },
                    { key: 'success', value: { boolValue: true } },
                    { key: 'latency', value: { doubleValue: 1.5 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);
    const trace = getTrace(traces, 0);

    expect(trace.SpanAttributes).toEqual({
      'http.method': 'POST',
      'http.status_code': '200',
      success: 'true',
      latency: '1.5',
    });
  });

  it('should transform resource attributes to string record', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'api-gateway' } },
              { key: 'service.version', value: { stringValue: '1.2.3' } },
              { key: 'deployment.environment', value: { stringValue: 'production' } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abcdef1234567890abcdef1234567890',
                  spanId: 'fedcba0987654321',
                  name: 'resource-test',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
              ],
            },
          ],
        },
      ],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);
    const trace = getTrace(traces, 0);

    expect(trace.ServiceName).toBe('api-gateway');
    expect(trace.ResourceAttributes).toEqual({
      'service.name': 'api-gateway',
      'service.version': '1.2.3',
      'deployment.environment': 'production',
    });
  });

  it('should map span kind integers to strings', () => {
    const kinds = [
      { kind: 0, expected: 'SPAN_KIND_UNSPECIFIED' },
      { kind: 1, expected: 'SPAN_KIND_INTERNAL' },
      { kind: 2, expected: 'SPAN_KIND_SERVER' },
      { kind: 3, expected: 'SPAN_KIND_CLIENT' },
      { kind: 4, expected: 'SPAN_KIND_PRODUCER' },
      { kind: 5, expected: 'SPAN_KIND_CONSUMER' },
    ];

    for (const { kind, expected } of kinds) {
      const request: OTLPExportTraceServiceRequest = {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 'abcdef1234567890abcdef1234567890',
                    spanId: 'fedcba0987654321',
                    name: 'kind-test',
                    kind,
                    startTimeUnixNano: '1000000000',
                    endTimeUnixNano: '2000000000',
                  },
                ],
              },
            ],
          },
        ],
      };

      const traces = transformOTLPToTraces(request, apiKey, receivedAt);
      const trace = getTrace(traces, 0);
      expect(trace.SpanKind).toBe(expected);
    }
  });

  it('should map status codes to strings', () => {
    const statuses = [
      { code: 0, expected: 'STATUS_CODE_UNSET' },
      { code: 1, expected: 'STATUS_CODE_OK' },
      { code: 2, expected: 'STATUS_CODE_ERROR' },
    ];

    for (const { code, expected } of statuses) {
      const request: OTLPExportTraceServiceRequest = {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 'abcdef1234567890abcdef1234567890',
                    spanId: 'fedcba0987654321',
                    name: 'status-test',
                    startTimeUnixNano: '1000000000',
                    endTimeUnixNano: '2000000000',
                    status: { code, message: '' },
                  },
                ],
              },
            ],
          },
        ],
      };

      const traces = transformOTLPToTraces(request, apiKey, receivedAt);
      const trace = getTrace(traces, 0);
      expect(trace.StatusCode).toBe(expected);
    }
  });

  it('should transform span events to parallel arrays', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abcdef1234567890abcdef1234567890',
                  spanId: 'fedcba0987654321',
                  name: 'events-test',
                  startTimeUnixNano: '1000000', // 1ms
                  endTimeUnixNano: '3000000', // 3ms
                  events: [
                    {
                      name: 'exception',
                      timeUnixNano: '1500000', // 1.5ms
                      attributes: [{ key: 'exception.type', value: { stringValue: 'Error' } }],
                    },
                    {
                      name: 'log',
                      timeUnixNano: '2000000', // 2ms
                      attributes: [{ key: 'message', value: { stringValue: 'Processing' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);
    const trace = getTrace(traces, 0);

    expect(trace['Events.Timestamp']).toEqual([1500000, 2000000]); // Nanoseconds
    expect(trace['Events.Name']).toEqual(['exception', 'log']);
    expect(trace['Events.Attributes']).toEqual([
      '{"exception.type":"Error"}',
      '{"message":"Processing"}',
    ]);
  });

  it('should transform span links to parallel arrays', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abcdef1234567890abcdef1234567890',
                  spanId: 'fedcba0987654321',
                  name: 'links-test',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                  links: [
                    {
                      traceId: 'linked-trace-1234567890abcdef12',
                      spanId: 'linked-span-1234',
                      traceState: 'vendor=value',
                      attributes: [{ key: 'link.type', value: { stringValue: 'parent' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);
    const trace = getTrace(traces, 0);

    expect(trace['Links.TraceId']).toEqual(['linked-trace-1234567890abcdef12']);
    expect(trace['Links.SpanId']).toEqual(['linked-span-1234']);
    expect(trace['Links.TraceState']).toEqual(['vendor=value']);
    expect(trace['Links.Attributes']).toEqual(['{"link.type":"parent"}']);
  });

  it('should handle parent span ID', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abcdef1234567890abcdef1234567890',
                  spanId: 'fedcba0987654321',
                  parentSpanId: 'parent1234567890',
                  name: 'child-span',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
              ],
            },
          ],
        },
      ],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);
    const trace = getTrace(traces, 0);

    expect(trace.ParentSpanId).toBe('parent1234567890');
  });

  it('should handle trace state', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abcdef1234567890abcdef1234567890',
                  spanId: 'fedcba0987654321',
                  traceState: 'vendor1=value1,vendor2=value2',
                  name: 'state-test',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
              ],
            },
          ],
        },
      ],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);
    const trace = getTrace(traces, 0);

    expect(trace.TraceState).toBe('vendor1=value1,vendor2=value2');
  });

  it('should handle multiple spans across multiple scopes', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'service-a' } }],
          },
          scopeSpans: [
            {
              scope: { name: 'library-1' },
              spans: [
                {
                  traceId: 'trace1234567890abcdef1234567890',
                  spanId: 'span-1-abcdef12',
                  name: 'span-1',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
              ],
            },
            {
              scope: { name: 'library-2' },
              spans: [
                {
                  traceId: 'trace1234567890abcdef1234567890',
                  spanId: 'span-2-abcdef12',
                  name: 'span-2',
                  startTimeUnixNano: '1500000000',
                  endTimeUnixNano: '2500000000',
                },
              ],
            },
          ],
        },
      ],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);

    expect(traces).toHaveLength(2);
    expect(getTrace(traces, 0).SpanName).toBe('span-1');
    expect(getTrace(traces, 1).SpanName).toBe('span-2');
    expect(getTrace(traces, 0).ServiceName).toBe('service-a');
    expect(getTrace(traces, 1).ServiceName).toBe('service-a');
  });

  it('should handle multiple resource spans', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'service-a' } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abcdef1234567890abcdef1234567890',
                  spanId: 'span-a-12345678',
                  name: 'span-from-a',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
              ],
            },
          ],
        },
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'service-b' } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abcdef1234567890abcdef1234567890',
                  spanId: 'span-b-12345678',
                  name: 'span-from-b',
                  startTimeUnixNano: '1500000000',
                  endTimeUnixNano: '2500000000',
                },
              ],
            },
          ],
        },
      ],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);

    expect(traces).toHaveLength(2);
    expect(getTrace(traces, 0).ServiceName).toBe('service-a');
    expect(getTrace(traces, 1).ServiceName).toBe('service-b');
  });

  it('should default to unknown service name when not provided', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abcdef1234567890abcdef1234567890',
                  spanId: 'fedcba0987654321',
                  name: 'no-service-test',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
              ],
            },
          ],
        },
      ],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);
    const trace = getTrace(traces, 0);

    expect(trace.ServiceName).toBe('unknown');
  });

  it('should return empty array for empty request', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);

    expect(traces).toHaveLength(0);
  });

  it('should handle status message', () => {
    const request: OTLPExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abcdef1234567890abcdef1234567890',
                  spanId: 'fedcba0987654321',
                  name: 'error-span',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                  status: { code: 2, message: 'Connection refused' },
                },
              ],
            },
          ],
        },
      ],
    };

    const traces = transformOTLPToTraces(request, apiKey, receivedAt);
    const trace = getTrace(traces, 0);

    expect(trace.StatusCode).toBe('STATUS_CODE_ERROR');
    expect(trace.StatusMessage).toBe('Connection refused');
  });
});
