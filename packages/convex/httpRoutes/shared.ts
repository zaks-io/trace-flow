import {
  axiomConfigFromEnv,
  createConvexLogger,
  traceContextFromHeaders,
  type LogContext,
} from '@trace-flow/logging';

export function getRequestLogger(request: Request, context?: LogContext) {
  return createConvexLogger({
    service: 'convex',
    convexFunction: 'http',
    axiom: axiomConfigFromEnv({
      AXIOM_TOKEN: process.env.AXIOM_TOKEN,
      AXIOM_DATASET: process.env.AXIOM_DATASET,
      AXIOM_DOMAIN: process.env.AXIOM_DOMAIN,
    }),
    context: {
      component: 'http',
      ...traceContextFromHeaders(request.headers),
      ...(context ?? {}),
    },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLength = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLength; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export function hasValidBearerSecret(
  authHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !authHeader?.startsWith('Bearer ')) return false;
  return timingSafeEqual(authHeader.slice(7), secret);
}

export function isJsonContentType(contentType: string | undefined): boolean {
  const normalized = contentType?.toLowerCase().trim();
  if (!normalized) return false;
  return normalized === 'application/json' || normalized.startsWith('application/json;');
}

const CONVEX_DOCUMENT_ID_PATTERN = /^[a-z0-9]{32}$/;

export function isConvexDocumentId(value: unknown): value is string {
  return typeof value === 'string' && CONVEX_DOCUMENT_ID_PATTERN.test(value);
}
