/**
 * Baseline security headers applied to every HTTP-serving worker response.
 *
 * CSP is intentionally NOT included here — only the web worker serves HTML and
 * sets its own Content-Security-Policy with a per-request nonce. API/proxy
 * workers serve JSON or streamed LLM responses and rely solely on this baseline.
 */
export const BASELINE_SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
} as const;

export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(BASELINE_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
}
