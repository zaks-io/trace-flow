export function isConvexTokenUsable(token: string | undefined, nowMs = Date.now()): boolean {
  if (!token) return false;

  const payload = token.split('.')[1];
  if (!payload) return false;

  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const decoded = JSON.parse(atob(padded)) as {
      exp?: unknown;
    };
    return typeof decoded.exp === 'number' && decoded.exp * 1000 > nowMs;
  } catch {
    return false;
  }
}
