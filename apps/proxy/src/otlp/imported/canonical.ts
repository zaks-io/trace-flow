import { IMPORTED_EXECUTION } from '@trace-flow/otel-conventions';
import { sha256Hex } from '@trace-flow/utils';
import type { OTLPSpan } from '../types';

const IDENTITY_DOMAIN = 'tf.imported_execution.identity.v1\0';
const SOURCE_DOMAIN = 'tf.imported_execution.source.v1\n';

export async function importedExecutionIdentity(
  orgId: string,
  installationId: string,
  executionId: string,
): Promise<string> {
  if (!orgId || !installationId || !executionId) {
    throw new Error('Imported execution identity is incomplete');
  }
  return sha256Hex(`${IDENTITY_DOMAIN}${orgId}\0${installationId}\0${executionId}`);
}

export async function importedExecutionSourceHash(
  installationId: string,
  executionId: string,
  span: OTLPSpan,
  sourceAttributes: Record<string, string>,
): Promise<string> {
  const projection = {
    contract: IMPORTED_EXECUTION.CONTRACT,
    installationId,
    executionId,
    traceId: span.traceId.toLowerCase(),
    spanId: span.spanId.toLowerCase(),
    parentSpanId: span.parentSpanId?.toLowerCase() ?? '',
    startNs: BigInt(span.startTimeUnixNano).toString(),
    endNs: BigInt(span.endTimeUnixNano).toString(),
    status: span.status?.code,
    attributes: Object.entries(sourceAttributes).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  };
  return sha256Hex(`${SOURCE_DOMAIN}${JSON.stringify(projection)}`);
}
