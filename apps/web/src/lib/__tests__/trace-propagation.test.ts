import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiTracePropagationTargets } from '../trace-propagation';

const matches = (targets: (string | RegExp)[], url: string): boolean =>
  targets.some((target) => (typeof target === 'string' ? url.includes(target) : target.test(url)));

describe('apiTracePropagationTargets', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('propagates to the configured API origins', () => {
    vi.stubEnv(
      'NEXT_PUBLIC_PIPES_API_URL',
      'https://trace-flow-pipes-api-dev.isaac-a46.workers.dev',
    );
    vi.stubEnv('NEXT_PUBLIC_RAW_API_URL', 'https://raw.trace-flow.dev');

    const targets = apiTracePropagationTargets();

    expect(
      matches(targets, 'https://trace-flow-pipes-api-dev.isaac-a46.workers.dev/v0/pipes/x'),
    ).toBe(true);
    expect(matches(targets, 'https://raw.trace-flow.dev/bodies/abc')).toBe(true);
    expect(matches(targets, '/api/internal')).toBe(true);
  });

  it('does not propagate to a third party that embeds an API origin in its URL', () => {
    vi.stubEnv('NEXT_PUBLIC_PIPES_API_URL', 'https://pipes.trace-flow.dev');

    const targets = apiTracePropagationTargets();

    expect(matches(targets, 'https://evil.example/?next=https://pipes.trace-flow.dev')).toBe(false);
  });

  it('keeps the local API fallback the data fetchers use when no API URL is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_PIPES_API_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_RAW_API_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_API_URL', undefined);

    expect(matches(apiTracePropagationTargets(), 'http://localhost:8788/bodies/abc')).toBe(true);
  });

  it('ignores an unparseable API URL rather than throwing', () => {
    vi.stubEnv('NEXT_PUBLIC_PIPES_API_URL', 'not a url');

    expect(() => apiTracePropagationTargets()).not.toThrow();
  });
});
