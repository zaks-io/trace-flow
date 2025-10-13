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

  const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(bytes);
}

export interface ResponseCaptureResult {
  readable: ReadableStream<Uint8Array>;
  capturedChunks: Uint8Array[];
  firstTokenReceived: number | undefined;
}

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
        firstTokenReceived = Date.now();
        isFirstChunk = false;
      }
      capturedChunks.push(chunk);

      if (onChunk) {
        onChunk(chunk, !isFirstChunk);
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
