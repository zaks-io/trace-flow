import { describe, expect, it } from 'vitest';
import { getDocs, getDocPath } from '@/lib/docs';
import sitemap from './sitemap';

describe('sitemap', () => {
  it('lists every public HTML page at its canonical URL', () => {
    const urls = sitemap().map((entry) => entry.url);

    expect(urls).toEqual([
      'https://trace-flow.dev/',
      'https://trace-flow.dev/docs',
      'https://trace-flow.dev/security',
      'https://trace-flow.dev/terms',
      'https://trace-flow.dev/privacy',
      ...getDocs().map((doc) => `https://trace-flow.dev${getDocPath(doc.slug)}`),
    ]);
  });
});
