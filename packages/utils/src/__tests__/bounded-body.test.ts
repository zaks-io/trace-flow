import { describe, expect, it, vi } from 'vitest';
import type { BodySizeLimitError } from '../bounded-body';
import { readBodyWithLimit, readRequestBodyWithLimit } from '../bounded-body';

describe('readBodyWithLimit', () => {
  it('returns the complete body when it fits', async () => {
    const body = new Blob(['hello', ' world']).stream();

    const result = await readBodyWithLimit(body, 11);

    expect(new TextDecoder().decode(result)).toBe('hello world');
  });

  it('cancels a chunked body as soon as it exceeds the limit', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel,
    });

    await expect(readBodyWithLimit(body, 10)).rejects.toEqual(
      expect.objectContaining<Partial<BodySizeLimitError>>({
        name: 'BodySizeLimitError',
        maxBytes: 10,
        receivedBytes: 12,
      }),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('readRequestBodyWithLimit', () => {
  it('rejects an oversized declared content length before reading', async () => {
    const request = new Request('https://example.com', {
      method: 'POST',
      headers: { 'Content-Length': '11' },
      body: 'hello world',
    });

    await expect(readRequestBodyWithLimit(request, 10)).rejects.toEqual(
      expect.objectContaining<Partial<BodySizeLimitError>>({
        name: 'BodySizeLimitError',
        maxBytes: 10,
        receivedBytes: 11,
      }),
    );
  });

  it('reads a request whose body is within the limit', async () => {
    const request = new Request('https://example.com', { method: 'POST', body: 'hello' });

    const result = await readRequestBodyWithLimit(request, 5);

    expect(new TextDecoder().decode(result)).toBe('hello');
  });
});
