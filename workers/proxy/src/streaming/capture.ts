import { getCurrentTimestamp } from '@observe/utils';

/**
 * Consumes a ReadableStream and returns its entire contents as a string.
 * Used to capture request bodies after they've been tee'd for proxying.
 * The stream must be fully consumed before we can send the queue message.
 */
export async function captureStream(stream: ReadableStream | null): Promise<string> {
  if (!stream) return '';

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value instanceof Uint8Array) {
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
 * Creates a TransformStream that captures response data while simultaneously streaming it to the client.
 * This pattern is critical for low-latency proxying - we never block the client response to capture data.
 * The transform passes chunks through untouched while maintaining a side copy for storage and parsing.
 *
 * @param onChunk - Optional callback invoked on each chunk, used for SSE parsing
 * @returns Transform stream, captured chunks getter, and TTFB (time to first byte) timestamp
 */
export function createResponseCapture(onChunk?: (chunk: Uint8Array, isFirst: boolean) => void): {
  transform: TransformStream<Uint8Array, Uint8Array>;
  getCapturedChunks: () => Uint8Array[];
  getFirstTokenTime: () => number | undefined;
} {
  const capturedChunks: Uint8Array[] = [];
  let isFirstChunk = true;
  let firstTokenReceived: number | undefined;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (isFirstChunk) {
        firstTokenReceived = getCurrentTimestamp();
      }
      capturedChunks.push(chunk);

      if (onChunk) {
        onChunk(chunk, isFirstChunk);
      }

      if (isFirstChunk) {
        isFirstChunk = false;
      }

      controller.enqueue(chunk);
    },
  });

  return {
    transform,
    getCapturedChunks: () => capturedChunks,
    getFirstTokenTime: () => firstTokenReceived,
  };
}
