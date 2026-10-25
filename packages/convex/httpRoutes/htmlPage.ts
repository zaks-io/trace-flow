// The small HTML pages the sign-in flows serve from the Convex site: MCP consent, Collector
// consent, and the Collector's one-time code. They share one shell so they look the same.

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function hiddenInput(name: string, value: string | undefined): string {
  if (value === undefined) return '';
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

/** A complete page around `body`, which must already be escaped. */
export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: Canvas;
      color: CanvasText;
    }
    main {
      box-sizing: border-box;
      width: min(520px, calc(100vw - 32px));
      border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-radius: 8px;
      padding: 24px;
    }
    h1 { margin: 0 0 16px; font-size: 20px; line-height: 1.2; }
    p { margin: 0 0 16px; line-height: 1.5; }
    dl { display: grid; gap: 12px; margin: 0 0 24px; }
    dt { font-size: 12px; font-weight: 700; text-transform: uppercase; color: color-mix(in srgb, CanvasText 62%, transparent); }
    dd { margin: 4px 0 0; overflow-wrap: anywhere; }
    .code {
      display: block;
      margin: 0 0 16px;
      padding: 12px;
      border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
      border-radius: 6px;
      font: 16px ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-wrap: anywhere;
      user-select: all;
    }
    .actions { display: flex; gap: 12px; align-items: center; }
    button, a {
      border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
      border-radius: 6px;
      padding: 9px 14px;
      font: inherit;
      color: CanvasText;
      text-decoration: none;
      background: Canvas;
    }
    button { background: CanvasText; color: Canvas; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>`;
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

/** Headers for a page whose only action is a form submitted back to this origin. */
export function formPageHeaders(setCookie: string): Record<string, string> {
  return {
    ...PAGE_HEADERS,
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'Set-Cookie': setCookie,
  };
}

/** Headers for a page that only shows text. */
export function staticPageHeaders(setCookie: string): Record<string, string> {
  return {
    ...PAGE_HEADERS,
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Set-Cookie': setCookie,
  };
}

/**
 * A 200 page that navigates to `url`. Consent forms submit by GET back to their authorize route,
 * and Chrome checks the consent page's `form-action 'self'` CSP against every redirect hop of that
 * submission, so a 302 there (self -> Auth0, and on silent SSO all the way to the client's
 * loopback callback) gets blocked. A 200 HTML redirect ends the form-submission chain before the
 * cross-origin navigation.
 */
export function redirectPage(url: string): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0;url=${escapeHtml(url)}">
  <title>Redirecting...</title>
</head>
<body>
  <p>Redirecting to authentication... <a href="${escapeHtml(url)}">Click here if not redirected</a></p>
  <script>window.location.replace(${JSON.stringify(url)});</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      ...PAGE_HEADERS,
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
