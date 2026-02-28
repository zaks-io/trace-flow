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
    'Accepts OTLP/HTTP JSON format traces for storage and analysis. Traces are validated, batched, and stored in ClickHouse for querying.',
  security: [{ apiKey: [] }],
  request: {
    headers: z.object({
      'x-trace-flow-api-key': z.string().openapi({
        description: 'API key for authentication',
        example: 'tf_xxxxxxxxxxxxxxxxxxxx',
      }),
      'content-type': z.literal('application/json'),
    }),
    body: {
      content: {
        'application/json': {
          schema: OTLPExportTraceServiceRequestSchema,
        },
      },
      description: 'OTLP trace export request containing resource spans',
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
      description: 'Unsupported content type - use application/json',
      content: {
        'application/json': {
          schema: OTLPErrorResponseSchema,
        },
      },
    },
  },
});
