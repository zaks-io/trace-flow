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
import {
  buildTraceDeliveryKey,
  encryptStoredBodyPayload,
  TRACE_DELIVERY_PREFIX,
} from '@trace-flow/utils';
import type { Logger } from '@trace-flow/logging';

const LIST_PAGE_SIZE = 1_000;
const SWEEP_SEND_CONCURRENCY = 10;
const MAX_SWEEP_PAGES = 10_000;
const SWEEP_MIN_AGE_MS = 5 * 60 * 1_000;

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

export async function sweepTraceDeliveries(
  storage: R2Bucket,
  queue: Queue<TraceDeliveryMessage>,
  logger: Logger,
  namespace: string,
  now = Date.now(),
): Promise<number> {
  const prefix = `${TRACE_DELIVERY_PREFIX}${validateNamespace(namespace)}-`;
  let cursor: string | undefined;
  let pageCount = 0;
  let enqueued = 0;
  let hasMore = true;

  while (hasMore) {
    const page = await storage.list({
      prefix,
      limit: LIST_PAGE_SIZE,
      cursor,
    });
    pageCount++;
    if (pageCount > MAX_SWEEP_PAGES) throw new Error('Trace delivery sweep exceeded page bound');

    const pending = page.objects.filter(
      (object) => now - object.uploaded.getTime() >= SWEEP_MIN_AGE_MS,
    );
    for (let offset = 0; offset < pending.length; offset += SWEEP_SEND_CONCURRENCY) {
      const batch = pending.slice(offset, offset + SWEEP_SEND_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((object) =>
          queue.send({
            type: 'delivery',
            key: object.key,
          }),
        ),
      );
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result?.status === 'fulfilled') {
          enqueued++;
        } else {
          logger.error('proxy.delivery_sweep_enqueue_failed', result?.reason, {
            key: batch[index]?.key,
          });
        }
      }
    }

    if (page.truncated) {
      if (!page.cursor || page.cursor === cursor) {
        throw new Error('Trace delivery sweep cursor did not advance');
      }
      cursor = page.cursor;
    } else {
      hasMore = false;
    }
  }

  return enqueued;
}

function validateNamespace(namespace: string): string {
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
