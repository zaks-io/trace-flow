import type { Context } from 'hono';
import { BodySizeLimitError, readBodyWithLimit } from '@trace-flow/utils';
import type { AgentIngestEnv } from './context';

export async function handleOrganizationErasure(
  c: Context<{ Bindings: AgentIngestEnv }>,
): Promise<Response> {
  const secret = c.env.AGENT_INGEST_SHARED_SECRET;
  const provided = c.req.header('Authorization');
  const expected = new TextEncoder().encode(`Bearer ${secret}`);
  const candidate = new TextEncoder().encode(provided ?? '');
  if (
    !secret ||
    candidate.byteLength !== expected.byteLength ||
    !crypto.subtle.timingSafeEqual(candidate, expected)
  ) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBodyWithLimit(c.req.raw.body, 2048)));
  } catch (error) {
    if (error instanceof BodySizeLimitError) return c.json({ error: 'request_too_large' }, 413);
    if (error instanceof SyntaxError) return c.json({ error: 'invalid_request' }, 400);
    throw error;
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !['orgId', 'afterId'].includes(key)) ||
    !('orgId' in body) ||
    typeof body.orgId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(body.orgId)
  ) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const afterId = 'afterId' in body ? body.afterId : undefined;
  if (
    afterId !== undefined &&
    (typeof afterId !== 'number' || !Number.isSafeInteger(afterId) || afterId < 0)
  ) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const result = await c.env.AGENT_CONSUMER.eraseOrganization(body.orgId, afterId);
  return c.json(result, result.ready ? 200 : 202);
}
