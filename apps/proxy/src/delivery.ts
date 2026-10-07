import type {
  BodyEncryptionConfig,
  EncryptedStoredBodiesPayload,
  StoredBodiesPayload,
  TraceDeliveryBody,
  TraceDeliveryEnvelope,
  TraceDeliveryMessage,
  TraceDeliveryPayload,
} from '@trace-flow/types';
import { buildStoredBodyKey } from '@trace-flow/types';
import { buildTraceDeliveryKey, encryptStoredBodyPayload } from '@trace-flow/utils';

interface BodyInput {
  requestId: string;
  requestBody: string;
  responseBody: string;
  truncated: boolean;
  orgId: string;
  encryption: BodyEncryptionConfig;
}

export async function buildTraceDeliveryEnvelope(
  message: TraceDeliveryPayload,
  bodyInput?: BodyInput,
): Promise<TraceDeliveryEnvelope> {
  const body = bodyInput ? await encryptDeliveryBody(bodyInput) : undefined;
  return { version: 1, message, ...(body ? { body } : {}) };
}

export async function persistTraceDelivery(
  storage: R2Bucket,
  envelope: TraceDeliveryEnvelope,
  namespace: string,
): Promise<string> {
  const key = buildTraceDeliveryKey(`${validateNamespace(namespace)}-${crypto.randomUUID()}`);
  const stored = await storage.put(key, JSON.stringify(envelope), {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  if (!stored) throw new Error(`Trace delivery key collision: ${key}`);
  return key;
}

export async function enqueueTraceDelivery(
  queue: Queue<TraceDeliveryMessage>,
  key: string,
  message: TraceDeliveryPayload,
): Promise<void> {
  await queue.send({
    type: 'delivery',
    key,
    ...(message.sentry_trace_context ? { sentry_trace_context: message.sentry_trace_context } : {}),
  });
}

export function validateNamespace(namespace: string): string {
  if (typeof namespace !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(namespace)) {
    throw new Error('Trace delivery namespace must be a non-empty path-safe identifier');
  }
  return namespace;
}

async function encryptDeliveryBody(input: BodyInput): Promise<TraceDeliveryBody> {
  if (!input.encryption.rootKeyBase64) {
    throw new Error('Body encryption root key is required');
  }
  const key = buildStoredBodyKey(input.requestId);
  const plaintext: StoredBodiesPayload = {
    requestBody: input.requestBody,
    responseBody: input.responseBody,
    ...(input.truncated ? { truncated: true } : {}),
  };
  const encryptedPayload: EncryptedStoredBodiesPayload = await encryptStoredBodyPayload(
    JSON.stringify(plaintext),
    {
      rootKeyBase64: input.encryption.rootKeyBase64,
      keyId: input.encryption.keyId,
      orgId: input.orgId,
      objectKey: key,
    },
  );
  return { key, encryptedPayload, orgId: input.orgId };
}
