export class BodySizeLimitError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly receivedBytes: number,
  ) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = 'BodySizeLimitError';
  }
}

/** Reads at most `maxBytes`, canceling the incoming stream as soon as it crosses the limit. */
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<ArrayBuffer> {
  if (!body) return new ArrayBuffer(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodySizeLimitError(maxBytes, total);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}
