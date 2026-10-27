const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export function isValidS256Challenge(value: string): boolean {
  return S256_CHALLENGE_PATTERN.test(value);
}

export function isValidCodeVerifier(value: string): boolean {
  return CODE_VERIFIER_PATTERN.test(value);
}

/** The S256 challenge for `verifier`: base64url(SHA-256(verifier)), unpadded (RFC 7636). */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
