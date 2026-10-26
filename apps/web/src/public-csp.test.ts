import { describe, expect, it } from 'vitest';
import { protectStaticPage } from './public-csp';
import { CSP_HEADER_NAME } from './lib/csp';

const request = new Request('https://trace-flow.dev/terms');
const pages = { '/terms': { hashes: ['sha384-built-inline-script'], external: {} } };

describe('static page security boundary', () => {
  it('leaves machine-readable and RSC responses untouched', () => {
    for (const contentType of ['text/markdown', 'text/x-component', 'application/json']) {
      const response = new Response('content', { headers: { 'content-type': contentType } });
      expect(protectStaticPage(request, response, pages)).toBe(response);
    }
  });

  it('leaves unlisted dynamic pages on their existing nonce policy', () => {
    const response = new Response('dynamic', { headers: { 'content-type': 'text/html' } });
    expect(protectStaticPage(new Request('https://trace-flow.dev/app'), response, pages)).toBe(
      response,
    );
  });

  it('preserves HTML 404s for static-asset paths excluded by middleware', () => {
    const response = new Response('not found', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    });
    expect(
      protectStaticPage(new Request('https://trace-flow.dev/_next/static/missing.js'), response, {
        ...pages,
        '/_not-found': pages['/terms'],
      }),
    ).toBe(response);
  });

  it('requires protection for encoded spellings of prerendered routes', () => {
    expect(() =>
      protectStaticPage(
        new Request('https://trace-flow.dev/t%65rms'),
        new Response('html', { headers: { 'content-type': 'text/html' } }),
        pages,
      ),
    ).toThrow('Missing CSP');
  });

  it.each([
    undefined,
    "script-src 'self'",
    "script-src 'self' 'nonce-test'",
    "style-src 'nonce-test'; script-src 'self' 'strict-dynamic'",
  ])('rejects a static page without the required strict script policy: %s', (csp) => {
    const headers = new Headers({ 'content-type': 'text/html' });
    if (csp) headers.set(CSP_HEADER_NAME, csp);
    expect(() => protectStaticPage(request, new Response('html', { headers }), pages)).toThrow(
      /Missing .*policy|Missing CSP/,
    );
  });
});
