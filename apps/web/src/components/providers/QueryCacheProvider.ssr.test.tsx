import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryCacheProvider } from './QueryCacheProvider';

describe('QueryCacheProvider SSR', () => {
  it('renders only the fallback before browser identity storage is available', () => {
    const html = renderToStaticMarkup(
      <QueryCacheProvider identity="known-user" fallback={<span>loading</span>}>
        <span>private</span>
      </QueryCacheProvider>,
    );

    expect(html).toBe('<span>loading</span>');
  });
});
