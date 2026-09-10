export function hasInternalArchiveAuthority(
  authHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !authHeader?.startsWith('Bearer ')) return false;
  const provided = authHeader.slice(7);
  if (provided.length !== secret.length) return false;
  let diff = 0;
  for (let index = 0; index < secret.length; index++) {
    diff |= provided.charCodeAt(index) ^ secret.charCodeAt(index);
  }
  return diff === 0;
}
