const PROD_CONNECT_SRC = [
  "'self'",
  'https://pipes.trace-flow.dev',
  'https://raw.trace-flow.dev',
  'https://*.convex.cloud',
  'wss://*.convex.cloud',
  'https://auth0.zaks.io',
  'https://*.ingest.sentry.io',
  'https://*.ingest.us.sentry.io',
  'https://*.launchdarkly.com',
  'https://clientstream.launchdarkly.com',
  'https://events.launchdarkly.com',
  'https://app.launchdarkly.com',
];

const DEV_CONNECT_SRC = ['http://localhost:*', 'ws://localhost:*', 'http://127.0.0.1:*'];

export const CSP_HEADER_NAME = 'Content-Security-Policy-Report-Only';

export function buildSentryReportUri(dsn: string | undefined): string | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    const key = url.username;
    if (!projectId || !key) return null;
    return `${url.protocol}//${url.host}/api/${projectId}/security/?sentry_key=${key}`;
  } catch {
    return null;
  }
}

export function readOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function buildCsp(
  nonce: string,
  isDev: boolean,
  reportUri: string | null,
  readOrigins: string[] = [],
): string {
  const extraOrigins = readOrigins.filter((origin) => origin.length > 0);
  const baseConnectSrc = isDev ? [...PROD_CONNECT_SRC, ...DEV_CONNECT_SRC] : PROD_CONNECT_SRC;
  const connectSrc = [...new Set([...baseConnectSrc, ...extraOrigins])];

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src ${connectSrc.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'self' https://auth0.zaks.io",
    "frame-ancestors 'none'",
    "form-action 'self' https://auth0.zaks.io",
    "base-uri 'self'",
    "object-src 'none'",
  ];

  if (reportUri) directives.push(`report-uri ${reportUri}`);

  return directives.join('; ');
}
