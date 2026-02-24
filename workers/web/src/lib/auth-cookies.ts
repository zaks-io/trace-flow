import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';

export function clearAuthCookies(request: NextRequest, response: NextResponse) {
  response.cookies.delete('__session');
  for (let i = 0; i < 20; i++) {
    response.cookies.delete(`__session__${i}`);
  }
  for (const { name } of request.cookies.getAll()) {
    if (name.startsWith('__txn_')) {
      response.cookies.delete(name);
    }
  }
  response.cookies.delete('appSession');
  for (let i = 0; i < 20; i++) {
    response.cookies.delete(`appSession.${i}`);
  }
}

// Variant without request access — omits __txn_ transaction cookies since we can't
// enumerate them. Transaction cookies are short-lived OAuth flow state and only
// matter during an active login redirect, so skipping them here is safe.
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
