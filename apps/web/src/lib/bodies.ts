import { formatBodyForDisplay, type FormattedBody } from '@trace-flow/utils';
import type { StoredBodiesPayload } from '@trace-flow/types';

interface FormattedStoredBodies {
  requestBody: FormattedBody | null;
  responseBody: FormattedBody | null;
  truncated: boolean;
}

export async function fetchStoredBodies(
  requestId: string,
  token: string,
  signal: AbortSignal,
): Promise<StoredBodiesPayload | null> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8788';

  const res = await fetch(`${apiUrl}/bodies/${requestId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

  if (!res.ok) {
    if (res.status === 403 || res.status === 404 || res.status === 410) return null;

    const errorData = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new Error(
      errorData?.message ?? errorData?.error ?? `HTTP ${res.status}: ${res.statusText}`,
    );
  }

  const data: unknown = await res.json();

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Invalid body payload: expected an object');
  }

  return data as StoredBodiesPayload;
}

export function formatStoredBodiesForDisplay(
  payload: StoredBodiesPayload | null,
): FormattedStoredBodies {
  return {
    requestBody: formatBodyForDisplay(payload?.requestBody ?? null),
    responseBody: formatBodyForDisplay(payload?.responseBody ?? null),
    truncated: payload?.truncated === true,
  };
}
