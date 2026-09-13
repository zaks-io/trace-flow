import { describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import type { AgentIngestEnv } from '../context';

function fixture(ready = true) {
  const eraseOrganization = vi.fn(async () => ({ ready }));
  const env = {
    AGENT_INGEST_SHARED_SECRET: 'internal-secret',
    AGENT_CONSUMER: { eraseOrganization },
  } as unknown as AgentIngestEnv;
  return { eraseOrganization, env };
}
function request(body: string, authorization = 'Bearer internal-secret') {
  return new Request('https://ingest.test/internal/organization-erasure', {
    method: 'POST',
    headers: { Authorization: authorization },
    body,
  });
}

describe('organization erasure authority', () => {
  it.each(['', 'Bearer collector-secret', 'Bearer internal-secrex'])(
    'rejects invalid internal authority before any service call',
    async (authorization) => {
      const { eraseOrganization, env } = fixture();
      expect((await app.fetch(request('{"orgId":"org-1"}', authorization), env)).status).toBe(401);
      expect(eraseOrganization).not.toHaveBeenCalled();
    },
  );
  it.each(['{}', '{"orgId":"a:b"}', '{"orgId":"org-1","extra":true}', '[]'])(
    'rejects malformed deletion scope',
    async (body) => {
      const { eraseOrganization, env } = fixture();
      expect((await app.fetch(request(body), env)).status).toBe(400);
      expect(eraseOrganization).not.toHaveBeenCalled();
    },
  );
  it('bounds the internal request body before accessing the coordinator', async () => {
    const { eraseOrganization, env } = fixture();
    expect((await app.fetch(request('x'.repeat(2049)), env)).status).toBe(413);
    expect(eraseOrganization).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'reports settled=$ready without treating pending work as erased',
    async (ready) => {
      const { eraseOrganization, env } = fixture(ready);
      const response = await app.fetch(request('{"orgId":"org-1"}'), env);
      expect(response.status).toBe(ready ? 200 : 202);
      expect(await response.json()).toEqual({ ready });
      expect(eraseOrganization).toHaveBeenCalledWith('org-1', undefined);
    },
  );
});
