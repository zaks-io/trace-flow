import { RETENTION_DAYS } from '@trace-flow/types';
import type { TinybirdTrace } from '@trace-flow/types';
import { SPAN_KIND, STATUS_CODE } from '@trace-flow/otel-conventions';
import type {
  OTLPExportTraceServiceRequest,
  OTLPKeyValue,
  OTLPAnyValue,
  OTLPSpan,
  OTLPResource,
} from './types';

// OTLP carries the full OTel SpanKind set. The consumer path's createSpan covers
// only the CLIENT/INTERNAL pair used by the LLM Request flow; the broader set
// lives here at the bring-your-own-keys ingestion boundary. (Per the OTel
// semantic-conventions ADR, OTLP attributes pass through verbatim.)
const SPAN_KIND_MAP: Record<number, string> = {
  0: 'SPAN_KIND_UNSPECIFIED',
  1: SPAN_KIND.INTERNAL,
  2: 'SPAN_KIND_SERVER',
  3: SPAN_KIND.CLIENT,
  4: 'SPAN_KIND_PRODUCER',
  5: 'SPAN_KIND_CONSUMER',
};

const STATUS_CODE_MAP: Record<number, string> = {
  0: 'STATUS_CODE_UNSET',
  1: STATUS_CODE.OK,
  2: STATUS_CODE.ERROR,
};

/**
 * Extracts a string value from an OTLP attribute value.
 * All attribute values are converted to strings for TinybirdTrace compatibility.
 */
function extractValue(value: OTLPAnyValue): string {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return String(value.boolValue);
  if (value.intValue !== undefined) return value.intValue;
  if (value.doubleValue !== undefined) return String(value.doubleValue);
  if (value.bytesValue !== undefined) return value.bytesValue;
  if (value.arrayValue) return JSON.stringify(value.arrayValue.values.map(extractValue));
  if (value.kvlistValue) {
    const obj: Record<string, string> = {};
    for (const kv of value.kvlistValue.values) {
      obj[kv.key] = extractValue(kv.value);
    }
    return JSON.stringify(obj);
  }
  return '';
}

/**
 * Converts OTLP key-value attributes to a flat string record.
 */
function attributesToRecord(attributes?: OTLPKeyValue[]): Record<string, string> {
  if (!attributes) return {};
  const result: Record<string, string> = {};
  for (const attr of attributes) {
    result[attr.key] = extractValue(attr.value);
  }
  return result;
}

/**
 * Extracts service name from OTLP resource attributes.
 */
function extractServiceName(resource?: OTLPResource): string {
  if (!resource?.attributes) return 'unknown';
  const serviceAttr = resource.attributes.find((attr) => attr.key === 'service.name');
  if (serviceAttr) {
    return extractValue(serviceAttr.value);
  }
  return 'unknown';
}

/**
 * Transforms a single OTLP span to TinybirdTrace format.
 * Keeps timestamps in nanoseconds to align with OTLP spec.
 */
const NANOSECONDS_PER_DAY = 24 * 60 * 60 * 1_000_000_000;

function retentionExpiresAt(receivedAt: number, tier: string | undefined): number {
  const retentionDays = tier === 'pro' ? RETENTION_DAYS.pro : RETENTION_DAYS.hobby;
  return receivedAt + retentionDays * NANOSECONDS_PER_DAY;
}

function transformSpan(
  span: OTLPSpan,
  resource: OTLPResource | undefined,
  apiKey: string,
  receivedAt: number,
  tier: string | undefined,
): TinybirdTrace {
  const startNano = BigInt(span.startTimeUnixNano);
  const endNano = BigInt(span.endTimeUnixNano);
  const durationNano = Number(endNano - startNano);

  const resourceAttrs = attributesToRecord(resource?.attributes);
  const serviceName = extractServiceName(resource);
  resourceAttrs['service.name'] = serviceName;

  const trace: TinybirdTrace = {
    ReceivedAt: receivedAt,
    Timestamp: Number(startNano),
    TraceId: span.traceId,
    SpanId: span.spanId,
    ParentSpanId: span.parentSpanId ?? '',
    TraceState: span.traceState ?? '',
    SpanName: span.name,
    SpanKind: SPAN_KIND_MAP[span.kind ?? 0] ?? 'SPAN_KIND_UNSPECIFIED',
    ServiceName: serviceName,
    ResourceAttributes: resourceAttrs,
    SpanAttributes: attributesToRecord(span.attributes),
    Duration: durationNano,
    StatusCode: STATUS_CODE_MAP[span.status?.code ?? 0] ?? 'STATUS_CODE_UNSET',
    StatusMessage: span.status?.message ?? '',
    ApiKey: apiKey,
    'Events.Timestamp': [],
    'Events.Name': [],
    'Events.Attributes': [],
    'Links.TraceId': [],
    'Links.SpanId': [],
    'Links.TraceState': [],
    'Links.Attributes': [],
    TierAtIngestion: tier === 'pro' ? 'pro' : 'hobby',
    RetentionExpiresAt: retentionExpiresAt(receivedAt, tier),
  };

  // Transform events - keep timestamps in nanoseconds
  if (span.events) {
    for (const event of span.events) {
      const eventTimeNano =
        event.timeUnixNano !== undefined && /^-?\d+$/.test(String(event.timeUnixNano))
          ? Number(BigInt(event.timeUnixNano))
          : Number(startNano);
      trace['Events.Timestamp'].push(eventTimeNano);
      trace['Events.Name'].push(event.name);
      trace['Events.Attributes'].push(JSON.stringify(attributesToRecord(event.attributes)));
    }
  }

  // Transform links
  if (span.links) {
    for (const link of span.links) {
      trace['Links.TraceId'].push(link.traceId);
      trace['Links.SpanId'].push(link.spanId);
      trace['Links.TraceState'].push(link.traceState ?? '');
      trace['Links.Attributes'].push(JSON.stringify(attributesToRecord(link.attributes)));
    }
  }

  return trace;
}

/**
 * Transforms an OTLP trace request into TinybirdTrace array.
 * @param receivedAt - System timestamp in nanoseconds when the traces were received
 */
export function transformOTLPToTraces(
  request: OTLPExportTraceServiceRequest,
  apiKey: string,
  receivedAt: number,
  tier?: string,
): TinybirdTrace[] {
  const traces: TinybirdTrace[] = [];

  for (const resourceSpan of request.resourceSpans) {
    const resource = resourceSpan.resource;

    for (const scopeSpan of resourceSpan.scopeSpans) {
      for (const span of scopeSpan.spans) {
        traces.push(transformSpan(span, resource, apiKey, receivedAt, tier));
      }
    }
  }

  return traces;
}

/**
 * Re-stamp the billing tier and retention window on already-transformed traces once the org's
 * recording policy (and therefore its real tier) is known. The initial transform runs before the
 * policy check so it can count spans; without this a `pro` org's OTLP spans would keep the default
 * `hobby` tier and expire 23 days early.
 */
export function applyTierToTraces(
  traces: TinybirdTrace[],
  receivedAt: number,
  tier: string | undefined,
): void {
  const resolvedTier = tier === 'pro' ? 'pro' : 'hobby';
  const expiresAt = retentionExpiresAt(receivedAt, tier);
  for (const trace of traces) {
    trace.TierAtIngestion = resolvedTier;
    trace.RetentionExpiresAt = expiresAt;
  }
}
