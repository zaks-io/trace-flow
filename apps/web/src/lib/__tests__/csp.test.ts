import { describe, expect, it } from 'vitest';
import { buildCsp } from '../csp';

function connectSrc(csp: string): string {
  return csp.split('; ').find((directive) => directive.startsWith('connect-src ')) ?? '';
}

describe('buildCsp', () => {
  it('allows exact raw and pipe read origins in production', () => {
    const directive = connectSrc(buildCsp('nonce', false, null));

    expect(directive).toContain('https://pipes.trace-flow.dev');
    expect(directive).toContain('https://raw.trace-flow.dev');
    expect(directive).not.toContain('https://api.trace-flow.dev');
    expect(directive).not.toContain('https://*.trace-flow.dev');
  });

  it('keeps localhost connect origins for development', () => {
    const directive = connectSrc(buildCsp('nonce', true, null));

    expect(directive).toContain('http://localhost:*');
    expect(directive).toContain('http://127.0.0.1:*');
  });

  it('adds configured preview read origins exactly', () => {
    const directive = connectSrc(
      buildCsp('nonce', false, null, [
        'https://trace-flow-pipes-api-preview.isaac-a46.workers.dev',
        'https://trace-flow-raw-api-preview.isaac-a46.workers.dev',
      ]),
    );

    expect(directive).toContain('https://trace-flow-pipes-api-preview.isaac-a46.workers.dev');
    expect(directive).toContain('https://trace-flow-raw-api-preview.isaac-a46.workers.dev');
    expect(directive).not.toContain('https://*.workers.dev');
  });
});
