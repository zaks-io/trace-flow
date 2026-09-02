import { describe, expect, it } from 'vitest';
import { addHomepageDiscoveryLinks } from './homepage-discovery';

describe('addHomepageDiscoveryLinks', () => {
  it('appends registered discovery relations to existing homepage links', () => {
    const response = addHomepageDiscoveryLinks(
      new Request('https://trace-flow.dev/?ref=agent'),
      new Response('home', { headers: { Link: '</font.woff2>; rel="preload"' } }),
    );

    const link = response.headers.get('link');
    expect(link).toContain('</font.woff2>; rel="preload"');
    expect(link).toContain('</.well-known/api-catalog>; rel="api-catalog"');
    expect(link).toContain('<https://gateway.trace-flow.dev/openapi.json>; rel="service-desc"');
    expect(link).toContain('</docs/sdk-reference.md>; rel="service-doc"');
    expect(link).toContain('</llms.txt>; rel="describedby"');
  });

  it('leaves non-homepage responses unchanged', () => {
    const original = new Response('docs');

    expect(addHomepageDiscoveryLinks(new Request('https://trace-flow.dev/docs'), original)).toBe(
      original,
    );
  });
});
