import { describe, expect, it, vi } from 'vitest';
import { negotiateMarkdown, type MarkdownConverter } from './markdown-negotiation';

function converter(result = '# Agent-ready page'): MarkdownConverter {
  return {
    toMarkdown: vi.fn(async () => ({
      format: 'markdown' as const,
      data: result,
      tokens: 4,
    })),
  };
}

describe('markdown content negotiation', () => {
  it('returns the original HTML response when Markdown was not requested', async () => {
    const original = new Response('<main>Browser page</main>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const markdown = converter();

    const response = await negotiateMarkdown(
      new Request('https://trace-flow.dev/'),
      original,
      markdown,
    );

    expect(await response.text()).toBe('<main>Browser page</main>');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('vary')).toBe('Accept');
    expect(markdown.toMarkdown).not.toHaveBeenCalled();
  });

  it('converts HTML when text/markdown is an accepted representation', async () => {
    const original = new Response('<main>Agent page</main>', {
      headers: {
        'cache-control': 'public, max-age=60',
        'content-encoding': 'gzip',
        'content-type': 'text/html; charset=utf-8',
        etag: 'html-etag',
        vary: 'RSC',
      },
    });
    const markdown = converter('# Agent page');

    const response = await negotiateMarkdown(
      new Request('https://trace-flow.dev/docs?source=agent', {
        headers: { accept: 'application/json, text/markdown' },
      }),
      original,
      markdown,
    );

    expect(await response.text()).toBe('# Agent page');
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('content-length')).toBe('12');
    expect(response.headers.get('x-markdown-tokens')).toBe('4');
    expect(response.headers.get('vary')).toBe('RSC, Accept');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.has('content-encoding')).toBe(false);
    expect(response.headers.has('etag')).toBe(false);
    expect(markdown.toMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'page.html', blob: expect.any(Blob) }),
      { conversionOptions: { html: { hostname: 'https://trace-flow.dev/docs?source=agent' } } },
    );
  });

  it('leaves HTML unchanged when text/markdown is explicitly unacceptable', async () => {
    const original = new Response('<main>Browser page</main>', {
      headers: { 'content-type': 'text/html' },
    });
    const markdown = converter();

    const response = await negotiateMarkdown(
      new Request('https://trace-flow.dev/', {
        headers: { accept: 'text/html, text/markdown;q=0' },
      }),
      original,
      markdown,
    );

    expect(await response.text()).toBe('<main>Browser page</main>');
    expect(response.headers.get('vary')).toBe('Accept');
    expect(markdown.toMarkdown).not.toHaveBeenCalled();
  });

  it('does not convert non-HTML responses', async () => {
    const original = Response.json({ ok: true });
    const markdown = converter();

    const response = await negotiateMarkdown(
      new Request('https://trace-flow.dev/api/status', {
        headers: { accept: 'text/markdown' },
      }),
      original,
      markdown,
    );

    expect(response).toBe(original);
    expect(markdown.toMarkdown).not.toHaveBeenCalled();
  });

  it('does not send authenticated pages through document conversion', async () => {
    const original = new Response('<main>Private dashboard</main>', {
      headers: { 'content-type': 'text/html' },
    });
    const markdown = converter();

    const response = await negotiateMarkdown(
      new Request('https://trace-flow.dev/app/agents', {
        headers: { accept: 'text/markdown' },
      }),
      original,
      markdown,
    );

    expect(response).toBe(original);
    expect(markdown.toMarkdown).not.toHaveBeenCalled();
  });

  it('fails loudly when Cloudflare cannot convert the page', async () => {
    const markdown: MarkdownConverter = {
      toMarkdown: vi.fn(async () => ({
        format: 'error' as const,
        error: 'unsupported document',
      })),
    };

    await expect(
      negotiateMarkdown(
        new Request('https://trace-flow.dev/', { headers: { accept: 'text/markdown' } }),
        new Response('<main>Agent page</main>', {
          headers: { 'content-type': 'text/html' },
        }),
        markdown,
      ),
    ).rejects.toThrow('Markdown conversion failed: unsupported document');
  });
});
