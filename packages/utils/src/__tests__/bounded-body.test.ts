import { describe, expect, it, vi } from 'vitest';
import type { BodySizeLimitError } from '../bounded-body';
import { readBodyWithLimit } from '../bounded-body';

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
