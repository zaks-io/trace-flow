import { getCurrentTimestamp } from '@trace-flow/utils';

/**
 * Consumes a ReadableStream and returns its entire contents as a string.
 * Used to capture request bodies after they've been tee'd for proxying.
 * The stream must be fully consumed before we can send the queue message.
 *
 * Enforces size limit to prevent OOM. If limit is exceeded, throws error
 * before returning captured data, preventing oversized requests from being proxied.
 *
 * @param stream - The readable stream to capture
 * @param maxSize - Optional maximum size in bytes (default: no limit)
 * @throws Error if stream exceeds maxSize during capture
 */
export async function captureStream(
  stream: ReadableStream | null,
  maxSize?: number,
): Promise<string> {
  if (!stream) return '';

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value instanceof Uint8Array) {
      totalSize += result.value.length;

      if (maxSize && totalSize > maxSize) {
        void reader.cancel();
        throw new Error(
          `Request body exceeds ${maxSize / (1024 * 1024)}MB limit (received ${totalSize} bytes)`,
        );
      }

      chunks.push(result.value);
    }
  }

  return chunksToString(chunks);
}

/**
 * Efficiently concatenates binary chunks into a single string.
 * Pre-allocates the output buffer to avoid multiple reallocations during concatenation.
 */
export function chunksToString(chunks: Uint8Array[]): string {
  const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Creates a TransformStream that captures response data while streaming it to the client.
 * One terminal byte and transport EOF remain withheld until the durable delivery is accepted.
 *
 * Implements size limits to prevent OOM (Workers have 128MB memory limit per isolate):
 * - 20MB response limit (handles ~1M tokens with overhead)
 * - 5000 chunk limit (prevents chunk count explosion)
 * - Truncates capture if limits exceeded while still streaming full response to client
 *
 * @param onChunk - Optional callback invoked on each chunk, used for SSE parsing
 * @returns Transform stream, durability gate, captured chunks, timing, and size status
 */
export function createResponseCapture(onChunk?: (chunk: Uint8Array, isFirst: boolean) => void): {
  transform: TransformStream<Uint8Array, Uint8Array>;
  getCapturedChunks: () => Uint8Array[];
  getFirstTokenTime: () => number | undefined;
  getTotalSize: () => number;
  getCapturedSize: () => number;
  isTruncated: () => boolean;
  waitForDrain: () => Promise<{ complete: true } | { complete: false; error: unknown }>;
  markDrained: () => void;
  markInterrupted: (error: unknown) => void;
  release: () => void;
  fail: (error: unknown) => void;
} {
  const MAX_RESPONSE_SIZE = 20 * 1024 * 1024;
  const MAX_CHUNKS = 5000;
  const capturedChunks: Uint8Array[] = [];
  let totalSize = 0;
  let capturedSize = 0;
  let truncated = false;
  let isFirstChunk = true;
  let firstTokenReceived: number | undefined;
  let pendingFinalByte: Uint8Array | undefined;
  let drainSettled = false;
  let resolveDrain!: (result: { complete: true } | { complete: false; error: unknown }) => void;
  const drainPromise = new Promise<{ complete: true } | { complete: false; error: unknown }>(
    (resolve) => {
      resolveDrain = resolve;
    },
  );
  let resolveGate!: () => void;
  let rejectGate!: (error: unknown) => void;
  const gatePromise = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  void gatePromise.catch(() => undefined);

  const settleDrain = (result: { complete: true } | { complete: false; error: unknown }) => {
    if (drainSettled) return;
    drainSettled = true;
    resolveDrain(result);
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (chunk.length === 0) return;

      const isFirst = isFirstChunk;
      if (isFirstChunk) {
        firstTokenReceived = getCurrentTimestamp();
        isFirstChunk = false;
      }

      totalSize += chunk.length;

      if (pendingFinalByte) controller.enqueue(pendingFinalByte);
      if (chunk.length > 1) controller.enqueue(chunk.subarray(0, chunk.length - 1));
      pendingFinalByte = chunk.length > 0 ? chunk.slice(chunk.length - 1) : pendingFinalByte;

      if (!truncated) {
        if (
          capturedSize + chunk.length <= MAX_RESPONSE_SIZE &&
          capturedChunks.length < MAX_CHUNKS
        ) {
          capturedChunks.push(chunk);
          capturedSize += chunk.length;
        } else {
          truncated = true;
          console.warn('Response capture truncated:', {
            totalSize,
            chunks: capturedChunks.length,
            maxSize: MAX_RESPONSE_SIZE,
          });
        }
      }

      if (onChunk) {
        onChunk(chunk, isFirst);
      }
    },
    async flush(controller) {
      settleDrain({ complete: true });
      await gatePromise;
      if (pendingFinalByte) controller.enqueue(pendingFinalByte);
    },
  });

  return {
    transform,
    getCapturedChunks: () => capturedChunks,
    getFirstTokenTime: () => firstTokenReceived,
    getTotalSize: () => totalSize,
    getCapturedSize: () => capturedSize,
    isTruncated: () => truncated,
    waitForDrain: () => drainPromise,
    markDrained: () => settleDrain({ complete: true }),
    markInterrupted: (error) => settleDrain({ complete: false, error }),
    release: resolveGate,
    fail: rejectGate,
  };
}
