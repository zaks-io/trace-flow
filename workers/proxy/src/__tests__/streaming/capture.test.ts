import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureStream, createResponseCapture } from '../../streaming/capture';

describe('captureStream', () => {
  it('should capture stream with single chunk', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('hello world'));
        controller.close();
      },
    });

    const result = await captureStream(stream);

    expect(result).toBe('hello world');
  });

  it('should capture stream with multiple chunks', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('hello '));
        controller.enqueue(encoder.encode('world'));
        controller.close();
      },
    });

    const result = await captureStream(stream);

    expect(result).toBe('hello world');
  });

  it('should return empty string for null stream', async () => {
    const result = await captureStream(null);

    expect(result).toBe('');
  });

  it('should handle empty stream', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const result = await captureStream(stream);

    expect(result).toBe('');
  });

  it('should handle large chunks', async () => {
    const encoder = new TextEncoder();
    const largeText = 'a'.repeat(10000);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(largeText));
        controller.close();
      },
    });

    const result = await captureStream(stream);

    expect(result).toBe(largeText);
    expect(result.length).toBe(10000);
  });
});

describe('createResponseCapture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('should capture all chunks', async () => {
    const encoder = new TextEncoder();
    const capture = createResponseCapture();
    const { transform } = capture;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('chunk1'));
        controller.enqueue(encoder.encode('chunk2'));
        controller.enqueue(encoder.encode('chunk3'));
        controller.close();
      },
    });

    await stream.pipeThrough(transform).pipeTo(
      new WritableStream({
        write() {
          // No-op for testing
        },
      }),
    );

    const chunks = capture.getCapturedChunks();
    expect(chunks).toHaveLength(3);

    const decoder = new TextDecoder();
    expect(decoder.decode(chunks[0])).toBe('chunk1');
    expect(decoder.decode(chunks[1])).toBe('chunk2');
    expect(decoder.decode(chunks[2])).toBe('chunk3');
  });

  it('should track first token time', async () => {
    const encoder = new TextEncoder();
    const mockTime = 1234567890;
    vi.setSystemTime(mockTime);

    const capture = createResponseCapture();
    const { transform } = capture;

    expect(capture.getFirstTokenTime()).toBeUndefined();

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('first'));
        controller.close();
      },
    });

    await stream.pipeThrough(transform).pipeTo(
      new WritableStream({
        write() {
          // No-op for testing
        },
      }),
    );

    expect(capture.getFirstTokenTime()).toBe(mockTime);

    vi.useRealTimers();
  });

  it('should only set first token time once', async () => {
    const encoder = new TextEncoder();
    const mockTime = 1234567890;
    vi.setSystemTime(mockTime);

    const capture = createResponseCapture();
    const { transform } = capture;

    let chunkCount = 0;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('first'));
        controller.enqueue(encoder.encode('second'));
        controller.close();
      },
    });

    const timeAdvancingWriter = new WritableStream({
      write() {
        chunkCount++;
        if (chunkCount === 1) {
          vi.setSystemTime(mockTime + 1000);
        }
      },
    });

    await stream.pipeThrough(transform).pipeTo(timeAdvancingWriter);

    expect(capture.getFirstTokenTime()).toBe(mockTime);

    vi.useRealTimers();
  });

  it('should call onChunk callback with correct params', async () => {
    const encoder = new TextEncoder();
    const onChunk = vi.fn();
    const capture = createResponseCapture(onChunk);
    const { transform } = capture;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('chunk1'));
        controller.enqueue(encoder.encode('chunk2'));
        controller.close();
      },
    });

    await stream.pipeThrough(transform).pipeTo(
      new WritableStream({
        write() {
          // No-op for testing
        },
      }),
    );

    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenNthCalledWith(1, expect.any(Uint8Array), true);
    expect(onChunk).toHaveBeenNthCalledWith(2, expect.any(Uint8Array), true);

    vi.useRealTimers();
  });

  it('should pass through chunks to output stream', async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const capture = createResponseCapture();
    const { transform } = capture;
    const outputChunks: string[] = [];

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('chunk1'));
        controller.enqueue(encoder.encode('chunk2'));
        controller.close();
      },
    });

    await stream.pipeThrough(transform).pipeTo(
      new WritableStream({
        write(chunk) {
          outputChunks.push(decoder.decode(chunk));
        },
      }),
    );

    expect(outputChunks).toEqual(['chunk1', 'chunk2']);

    vi.useRealTimers();
  });

  it('should work without onChunk callback', async () => {
    const encoder = new TextEncoder();
    const capture = createResponseCapture();
    const { transform } = capture;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('test'));
        controller.close();
      },
    });

    await expect(
      stream.pipeThrough(transform).pipeTo(
        new WritableStream({
          write() {
            // No-op for testing
          },
        }),
      ),
    ).resolves.not.toThrow();

    expect(capture.getCapturedChunks()).toHaveLength(1);

    vi.useRealTimers();
  });
});
