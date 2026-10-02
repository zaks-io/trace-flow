import { SOURCE_IMPORTED_EXECUTION, TRACE_FLOW } from '@trace-flow/otel-conventions';
import type { TinybirdTrace } from '@trace-flow/types';
import { transformSpan } from '../transform';
import { importedExecutionIdentity, importedExecutionSourceHash } from './canonical';
import type { ImportedExecutionInput } from './validate';

export async function buildImportedExecutionTraces(
  executions: ImportedExecutionInput[],
  apiKey: string,
  orgId: string,
  receivedAt: number,
): Promise<TinybirdTrace[]> {
  return Promise.all(
    executions.map(async ({ installationId, executionId, resource, span, attributes }) => {
      const [identity, sourceHash] = await Promise.all([
        importedExecutionIdentity(orgId, installationId, executionId),
        importedExecutionSourceHash(installationId, executionId, span, attributes),
      ]);
      const trace = transformSpan(span, resource, apiKey, receivedAt, undefined);
      trace.TraceId = span.traceId.toLowerCase();
      trace.SpanId = span.spanId.toLowerCase();
      trace.SpanAttributes = {
        ...attributes,
        [TRACE_FLOW.SOURCE]: SOURCE_IMPORTED_EXECUTION,
        [TRACE_FLOW.IMPORT_IDENTITY]: identity,
        [TRACE_FLOW.IMPORT_SOURCE_HASH]: sourceHash,
      };
      return trace;
    }),
  );
}
