import * as Sentry from '@sentry/cloudflare';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureSafeException } from './sentry-exception';

vi.mock('@sentry/cloudflare', () => ({ withScope: vi.fn() }));

function capture(
  event: Sentry.Event,
  diagnostics?: Parameters<typeof captureSafeException>[1]['diagnostics'],
) {
  let processed: Sentry.Event | null | undefined;
  const captureException = vi.fn();
  vi.mocked(Sentry.withScope).mockImplementation((...args) => {
    const callback = args[1] ?? args[0];
    if (typeof callback !== 'function') throw new Error('Missing Sentry scope callback');
    return callback({
      addEventProcessor: (processor: (input: Sentry.Event) => Sentry.Event) => {
        processed = processor(event);
      },
      captureException,
    } as unknown as Sentry.Scope);
  });
  const original = new Error('private provider body', { cause: new Error('private cause') });
  captureSafeException(original, { message: 'Safe failure', operation: 'test', diagnostics });
  expect(captureException).toHaveBeenCalledExactlyOnceWith(original);
  return processed;
}

beforeEach(() => vi.clearAllMocks());

describe('safe exception diagnostics', () => {
  it('keeps the existing strict scrubbing for callers without diagnostics', () => {
    const event = capture({
      exception: {
        values: [
          {
            type: 'PrivateType',
            value: 'private',
            stacktrace: { frames: [{ filename: 'index.js', lineno: 1 }] },
          },
        ],
      },
      extra: { private: true },
      message: 'private',
      logentry: { message: 'private' },
      threads: { values: [{ name: 'private' }] },
      breadcrumbs: [{ message: 'private' }],
      tags: { environment: 'test' },
    });
    expect(event?.exception?.values).toEqual([{ type: 'Error', value: 'Safe failure' }]);
    expect(event?.fingerprint).toEqual(['test']);
    expect(event?.tags).toEqual({ environment: 'test', operation: 'test' });
    expect(JSON.stringify(event)).not.toContain('private');
  });

  it('retains only selected context and allowlisted source coordinates of the outer error', () => {
    const event = capture(
      {
        exception: {
          values: [
            {
              type: 'PrivateCause',
              value: 'private cause',
              stacktrace: { frames: [{ filename: 'index.js', lineno: 9 }] },
            },
            {
              type: 'PrivateType',
              value: 'private message',
              stacktrace: {
                frames: [
                  {
                    filename: 'https://private.test/index.js?key=private#private',
                    abs_path: 'private',
                    function: 'private',
                    lineno: 10,
                    colno: 20,
                    vars: { private: true },
                    context_line: 'private',
                  },
                  { filename: '/private/customer.ts', lineno: 30 },
                  { filename: 'index.js', lineno: -1 },
                  { filename: 'index.js', lineno: 11, colno: Number.NaN },
                ],
              },
            },
          ],
        },
        extra: { providerResponse: 'private' },
        contexts: { trace: { trace_id: '1'.repeat(32), span_id: '2'.repeat(16) } },
      },
      {
        type: 'TypeError',
        context: { stage: 'start-copy', generation: 1 },
        stackFilenames: ['index.js'],
      },
    );
    expect(event?.exception?.values).toEqual([
      {
        type: 'TypeError',
        value: 'Safe failure',
        stacktrace: {
          frames: [
            { filename: 'index.js', lineno: 10, colno: 20 },
            { filename: 'index.js', lineno: 11 },
          ],
        },
      },
    ]);
    expect(event?.extra).toEqual({ stage: 'start-copy', generation: 1 });
    expect(event?.fingerprint).toEqual(['test', 'TypeError', 'Safe failure']);
    expect(event?.contexts?.trace?.trace_id).toBe('1'.repeat(32));
    expect(JSON.stringify(event)).not.toContain('private');
  });
});
