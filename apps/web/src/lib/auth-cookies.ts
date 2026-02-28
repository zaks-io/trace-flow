import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';

export function clearAuthCookies(request: NextRequest, response: NextResponse) {
  response.cookies.delete('__session');
  response.cookies.delete('appSession');

  // Enumerate chunked cookies from the request rather than guessing indices.
  // Auth0 SDK uses `${name}__${index}` (v4) and `${name}.${index}` (v3 legacy).
  // There's no hard limit on chunk count — the SDK splits at 3500 bytes per chunk.
  for (const { name } of request.cookies.getAll()) {
    if (
      name.startsWith('__txn_') ||
      /^__session__\d+$/.test(name) ||
      /^appSession\.\d+$/.test(name)
    ) {
      response.cookies.delete(name);
    }
  }
}

// Variant without request access — omits __txn_ transaction cookies since we can't
// enumerate them. Transaction cookies are short-lived OAuth flow state and only
// matter during an active login redirect, so skipping them here is safe.
//
// Without request access we can't enumerate chunked cookies. Iterate up to 20
// as a safe upper bound — a 70KB JWE session would need all 20 chunks at Auth0's
// 3500-byte chunk size, which far exceeds any real-world session payload.
export function clearAuthCookiesFromResponse(response: NextResponse) {
  response.cookies.delete('__session');
  for (let i = 0; i < 20; i++) {
    response.cookies.delete(`__session__${i}`);
  }
  response.cookies.delete('appSession');
  for (let i = 0; i < 20; i++) {
    response.cookies.delete(`appSession.${i}`);
  }
}
