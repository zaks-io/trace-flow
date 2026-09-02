import type { MetadataRoute } from 'next';
import { getDocs, getDocPath } from '@/lib/docs';

const SITE_URL = 'https://trace-flow.dev';
const PUBLIC_PAGE_PATHS = ['/', '/docs', '/security', '/terms', '/privacy'];

export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [...PUBLIC_PAGE_PATHS, ...getDocs().map((doc) => getDocPath(doc.slug))];

  return paths.map((path) => ({
    url: new URL(path, SITE_URL).toString(),
  }));
}
