import type { TinybirdTrace } from '@trace-flow/types';

export function createMockTrace(traceId: string): TinybirdTrace {
  return {
    ReceivedAt: 1700000000000000000,
    Timestamp: 1000000000,
    TraceId: traceId,
    SpanId: 'span-123',
    ParentSpanId: '',
    TraceState: '',
    SpanName: 'gen_ai.request',
    SpanKind: 'SPAN_KIND_CLIENT',
    ServiceName: 'llm-observability',
    ResourceAttributes: { 'service.name': 'llm-observability' },
    SpanAttributes: {
      'gen_ai.request_id': traceId,
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4',
    },
    Duration: 500000,
    StatusCode: 'STATUS_CODE_OK',
    StatusMessage: '',
    ApiKey: 'test-key',
    'Events.Timestamp': [],
    'Events.Name': [],
    'Events.Attributes': [],
    'Links.TraceId': [],
    'Links.SpanId': [],
    'Links.TraceState': [],
    'Links.Attributes': [],
    TierAtIngestion: 'hobby',
    RetentionExpiresAt: 1700604800000000000,
  };
}
