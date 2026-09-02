import type { MetadataRoute } from 'next';

const SITE_URL = 'https://trace-flow.dev';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api', '/app', '/auth', '/invite/', '/waitlist/confirm/'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
