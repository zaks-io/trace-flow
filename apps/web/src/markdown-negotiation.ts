type MarkdownDocument = {
  name: string;
  blob: Blob;
};

type MarkdownConversionOptions = {
  conversionOptions: {
    html: {
      hostname: string;
    };
  };
};

type MarkdownConversionResult =
  | { format: 'markdown' | 'text'; data: string; tokens: number }
  | { format: 'error'; error: string };

export interface MarkdownConverter {
  toMarkdown(
    document: MarkdownDocument,
    options: MarkdownConversionOptions,
  ): Promise<MarkdownConversionResult>;
}

const INVALIDATED_BODY_HEADERS = [
  'content-encoding',
  'content-range',
  'etag',
  'last-modified',
  'transfer-encoding',
];

function acceptsMarkdown(accept: string | null): boolean {
  if (!accept) return false;

  return accept.split(',').some((entry) => {
    const [mediaType, ...parameters] = entry.split(';').map((part) => part.trim());
    if (mediaType.toLowerCase() !== 'text/markdown') return false;

    const quality = parameters.find((parameter) => parameter.toLowerCase().startsWith('q='));
    if (!quality) return true;

    const value = Number.parseFloat(quality.slice(2));
    return Number.isFinite(value) && value > 0;
  });
}

function addVaryAccept(headers: Headers): void {
  const vary = headers.get('vary');
  if (vary === '*') return;

  const values = vary
    ? vary
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  if (!values.some((value) => value.toLowerCase() === 'accept')) values.push('Accept');
  headers.set('vary', values.join(', '));
}

function withVaryAccept(response: Response): Response {
  const headers = new Headers(response.headers);
  addVaryAccept(headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isPublicContentPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/privacy' ||
    pathname === '/security' ||
    pathname === '/terms' ||
    pathname === '/docs' ||
    pathname.startsWith('/docs/')
  );
}

export async function negotiateMarkdown(
  request: Request,
  response: Response,
  converter: MarkdownConverter,
): Promise<Response> {
  if (request.method !== 'GET' || !isPublicContentPath(new URL(request.url).pathname)) {
    return response;
  }

  const contentType = response.headers.get('content-type');
  if (!response.body || contentType?.split(';', 1)[0].trim().toLowerCase() !== 'text/html') {
    return response;
  }

  if (!acceptsMarkdown(request.headers.get('accept'))) {
    return withVaryAccept(response);
  }

  const html = await response.text();
  const result = await converter.toMarkdown(
    {
      name: 'page.html',
      blob: new Blob([html], { type: contentType }),
    },
    {
      conversionOptions: {
        html: { hostname: request.url },
      },
    },
  );

  if (result.format === 'error') {
    throw new Error(`Markdown conversion failed: ${result.error}`);
  }

  const headers = new Headers(response.headers);
  for (const header of INVALIDATED_BODY_HEADERS) headers.delete(header);
  headers.set('content-type', 'text/markdown; charset=utf-8');
  headers.set('content-length', String(new TextEncoder().encode(result.data).byteLength));
  headers.set('x-markdown-tokens', String(result.tokens));
  addVaryAccept(headers);

  return new Response(result.data, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
