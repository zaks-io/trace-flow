import { createRoute, z } from '@hono/zod-openapi';
import {
  OTLPExportTraceServiceRequestSchema,
  OTLPExportTraceServiceResponseSchema,
  OTLPErrorResponseSchema,
} from './schemas';

export const otlpTracesRoute = createRoute({
  method: 'post',
  path: '/v1/traces',
  tags: ['Traces'],
  summary: 'Ingest OpenTelemetry traces',
  description:
    'Accepts OTLP/HTTP traces (JSON or protobuf) for storage and analysis. Traces are validated, batched, and stored in ClickHouse for querying. Supports gzip/deflate Content-Encoding.',
  security: [{ apiKey: [] }],
  request: {
    headers: z.object({
      'x-trace-flow-api-key': z.string().openapi({
        description: 'API key for authentication',
        example: 'tf_xxxxxxxxxxxxxxxxxxxx',
      }),
      'content-type': z.enum(['application/json', 'application/x-protobuf']).openapi({
        description: 'OTLP/HTTP payload encoding',
      }),
    }),
    body: {
      content: {
        'application/json': {
          schema: OTLPExportTraceServiceRequestSchema,
        },
        'application/x-protobuf': {
          schema: z.string().openapi({
            type: 'string',
            format: 'binary',
            description:
              'OTLP/protobuf encoded ExportTraceServiceRequest (opentelemetry.proto.trace.v1)',
          }),
        },
      },
      description:
        'OTLP trace export request containing resource spans. Both OTLP/HTTP JSON and protobuf encodings are accepted.',
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Traces accepted successfully',
      content: {
        'application/json': {
          schema: OTLPExportTraceServiceResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid request body or validation error',
      content: {
        'application/json': {
          schema: OTLPErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Missing or invalid API key',
      content: {
        'application/json': {
          schema: OTLPErrorResponseSchema,
        },
      },
    },
    413: {
      description: 'Request body exceeds 10MB limit',
      content: {
        'application/json': {
          schema: OTLPErrorResponseSchema,
        },
      },
    },
    415: {
      description: 'Unsupported content type - use application/json or application/x-protobuf',
      content: {
        'application/json': {
          schema: OTLPErrorResponseSchema,
        },
      },
    },
  },
});
