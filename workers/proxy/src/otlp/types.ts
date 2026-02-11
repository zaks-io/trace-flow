/**
 * OTLP JSON type definitions matching the OpenTelemetry specification.
 * @see https://opentelemetry.io/docs/specs/otlp/
 */

export interface OTLPAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string; // int64 as string in JSON
  doubleValue?: number;
  arrayValue?: { values: OTLPAnyValue[] };
  kvlistValue?: { values: OTLPKeyValue[] };
  bytesValue?: string; // base64 encoded
}

export interface OTLPKeyValue {
  key: string;
  value: OTLPAnyValue;
}

export interface OTLPResource {
  attributes?: OTLPKeyValue[];
  droppedAttributesCount?: number;
}

interface OTLPInstrumentationScope {
  name?: string;
  version?: string;
  attributes?: OTLPKeyValue[];
  droppedAttributesCount?: number;
}

export interface OTLPSpanEvent {
  timeUnixNano?: string;
  name: string;
  attributes?: OTLPKeyValue[];
  droppedAttributesCount?: number;
}

export interface OTLPSpanLink {
  traceId: string;
  spanId: string;
  traceState?: string;
  attributes?: OTLPKeyValue[];
  droppedAttributesCount?: number;
  flags?: number;
}

export interface OTLPStatus {
  message?: string;
  code?: number; // 0=UNSET, 1=OK, 2=ERROR
}

export interface OTLPSpan {
  traceId: string;
  spanId: string;
  traceState?: string;
  parentSpanId?: string;
  flags?: number;
  name: string;
  kind?: number; // 0-5: UNSPECIFIED, INTERNAL, SERVER, CLIENT, PRODUCER, CONSUMER
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OTLPKeyValue[];
  droppedAttributesCount?: number;
  events?: OTLPSpanEvent[];
  droppedEventsCount?: number;
  links?: OTLPSpanLink[];
  droppedLinksCount?: number;
  status?: OTLPStatus;
}

interface OTLPScopeSpans {
  scope?: OTLPInstrumentationScope;
  spans: OTLPSpan[];
  schemaUrl?: string;
}

export interface OTLPResourceSpans {
  resource?: OTLPResource;
  scopeSpans: OTLPScopeSpans[];
  schemaUrl?: string;
}

export interface OTLPExportTraceServiceRequest {
  resourceSpans: OTLPResourceSpans[];
}

export interface OTLPExportTraceServiceResponse {
  partialSuccess?: {
    rejectedSpans?: number;
    errorMessage?: string;
  };
}
