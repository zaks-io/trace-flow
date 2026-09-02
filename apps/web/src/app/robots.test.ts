import { describe, expect, it } from 'vitest';
import robots from './robots';

describe('robots', () => {
  it('advertises the sitemap without exposing private or token-bearing routes', () => {
    expect(robots()).toEqual({
      rules: {
        userAgent: '*',
        allow: '/',
        disallow: ['/api', '/app', '/auth', '/invite/', '/waitlist/confirm/'],
      },
      sitemap: 'https://trace-flow.dev/sitemap.xml',
    });
  });
});
