import { z } from '@hono/zod-openapi';

/**
 * Zod schemas for OTLP JSON types matching the OpenTelemetry specification.
 * Used for OpenAPI documentation and request validation.
 * @see https://opentelemetry.io/docs/specs/otlp/
 */

/**
 * OTLP AnyValue schema - represents a polymorphic value type.
 * Nested arrays/kvlists use z.unknown() to avoid circular references
 * that OpenAPI generators cannot handle.
 */
export const OTLPAnyValueSchema = z
  .object({
    stringValue: z.string().optional(),
    boolValue: z.boolean().optional(),
    intValue: z.string().optional().openapi({ description: 'int64 as string' }),
    doubleValue: z.number().optional(),
    arrayValue: z
      .object({
        values: z.array(z.unknown()).openapi({ description: 'Array of AnyValue objects' }),
      })
      .optional(),
    kvlistValue: z
      .object({
        values: z.array(z.unknown()).openapi({ description: 'Array of KeyValue objects' }),
      })
      .optional(),
    bytesValue: z.string().optional().openapi({ description: 'base64 encoded bytes' }),
  })
  .openapi('OTLPAnyValue');

export const OTLPKeyValueSchema = z
  .object({
    key: z.string(),
    value: OTLPAnyValueSchema,
  })
  .openapi('OTLPKeyValue');

export const OTLPResourceSchema = z
  .object({
    attributes: z.array(OTLPKeyValueSchema).optional(),
    droppedAttributesCount: z.number().int().optional(),
  })
  .openapi('OTLPResource');

export const OTLPInstrumentationScopeSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    attributes: z.array(OTLPKeyValueSchema).optional(),
    droppedAttributesCount: z.number().int().optional(),
  })
  .openapi('OTLPInstrumentationScope');

export const OTLPSpanEventSchema = z
  .object({
    timeUnixNano: z.string().optional(),
    name: z.string(),
    attributes: z.array(OTLPKeyValueSchema).optional(),
    droppedAttributesCount: z.number().int().optional(),
  })
  .openapi('OTLPSpanEvent');

export const OTLPSpanLinkSchema = z
  .object({
    traceId: z.string(),
    spanId: z.string(),
    traceState: z.string().optional(),
    attributes: z.array(OTLPKeyValueSchema).optional(),
    droppedAttributesCount: z.number().int().optional(),
    flags: z.number().int().optional(),
  })
  .openapi('OTLPSpanLink');

export const OTLPStatusSchema = z
  .object({
    message: z.string().optional(),
    code: z
      .number()
      .int()
      .min(0)
      .max(2)
      .optional()
      .openapi({ description: '0=UNSET, 1=OK, 2=ERROR' }),
  })
  .openapi('OTLPStatus');

export const OTLPSpanSchema = z
  .object({
    traceId: z.string().openapi({ description: '32-character hex trace ID' }),
    spanId: z.string().openapi({ description: '16-character hex span ID' }),
    traceState: z.string().optional(),
    parentSpanId: z.string().optional().openapi({ description: '16-character hex parent span ID' }),
    flags: z.number().int().optional(),
    name: z.string().openapi({ description: 'Span operation name' }),
    kind: z.number().int().min(0).max(5).optional().openapi({
      description: '0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER',
    }),
    startTimeUnixNano: z
      .string()
      .openapi({ description: 'Start time in nanoseconds since Unix epoch' }),
    endTimeUnixNano: z
      .string()
      .openapi({ description: 'End time in nanoseconds since Unix epoch' }),
    attributes: z.array(OTLPKeyValueSchema).optional(),
    droppedAttributesCount: z.number().int().optional(),
    events: z.array(OTLPSpanEventSchema).optional(),
    droppedEventsCount: z.number().int().optional(),
    links: z.array(OTLPSpanLinkSchema).optional(),
    droppedLinksCount: z.number().int().optional(),
    status: OTLPStatusSchema.optional(),
  })
  .openapi('OTLPSpan');

export const OTLPScopeSpansSchema = z
  .object({
    scope: OTLPInstrumentationScopeSchema.optional(),
    spans: z.array(OTLPSpanSchema),
    schemaUrl: z.string().optional(),
  })
  .openapi('OTLPScopeSpans');

export const OTLPResourceSpansSchema = z
  .object({
    resource: OTLPResourceSchema.optional(),
    scopeSpans: z.array(OTLPScopeSpansSchema),
    schemaUrl: z.string().optional(),
  })
  .openapi('OTLPResourceSpans');

export const OTLPExportTraceServiceRequestSchema = z
  .object({
    resourceSpans: z.array(OTLPResourceSpansSchema).openapi({
      description: 'Collection of resource spans containing trace data',
    }),
  })
  .openapi('OTLPExportTraceServiceRequest');

export const OTLPPartialSuccessSchema = z
  .object({
    rejectedSpans: z.number().int().optional(),
    errorMessage: z.string().optional(),
  })
  .openapi('OTLPPartialSuccess');

export const OTLPExportTraceServiceResponseSchema = z
  .object({
    partialSuccess: OTLPPartialSuccessSchema.optional(),
  })
  .openapi('OTLPExportTraceServiceResponse');

export const OTLPErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.number().int(),
      message: z.string(),
    }),
  })
  .openapi('OTLPErrorResponse');
