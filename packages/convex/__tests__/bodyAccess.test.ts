import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  runAdminSql: vi.fn(),
}));

vi.mock('../rateLimits', () => ({
  rateLimiter: {
    limit: mocks.limit,
  },
}));

vi.mock('@trace-flow/tinybird-client', () => ({
  runAdminSql: mocks.runAdminSql,
  TinybirdQueryError: class TinybirdQueryError extends Error {},
}));

import { bodyAccessRateLimitKey, buildBodyAccessOwnershipSql, issueToken } from '../bodyAccess';

const VALID_API_KEY = '11111111-1111-1111-1111-111111111111';

function makeIssueTokenCtx() {
  return {
    runQuery: vi
      .fn()
      .mockResolvedValueOnce({
        sub: 'auth0|user',
        userId: 'user_123',
        orgId: 'org_123',
      })
      .mockResolvedValueOnce([{ key: VALID_API_KEY }]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BODY_ACCESS_JWT_SECRET = 'test-body-access-secret';
  process.env.TINYBIRD_ADMIN_TOKEN = 'test-tinybird-admin-token';
  delete process.env.TINYBIRD_API_URL;
  mocks.limit.mockResolvedValue(undefined);
  mocks.runAdminSql.mockResolvedValue([{ '1': 1 }]);
});

describe('body access token helpers', () => {
  it('rate-limits body token minting per user, not per request id', () => {
    const userId = 'user_123';

    expect(bodyAccessRateLimitKey(userId)).toBe(userId);
    expect(bodyAccessRateLimitKey(userId)).not.toContain('req_');
  });

  it('builds an ownership query scoped to sanitized API keys and request id', () => {
    const sql = buildBodyAccessOwnershipSql({
      requestId: "req_'quoted",
      apiKeys: [
        '11111111-1111-1111-1111-111111111111',
        'not-a-valid-key',
        '22222222-2222-2222-2222-222222222222',
      ],
    });

    expect(sql).toContain('FROM otel_trace_spans');
    expect(sql).toContain(
      "ApiKey IN ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222')",
    );
    expect(sql).toContain(
      "JSONExtractString(SpanAttributes, 'gen_ai.request_id') = 'req_''quoted'",
    );
    expect(sql).not.toContain('not-a-valid-key');
  });

  it('does not build an ownership query when the user has no valid API keys', () => {
    expect(
      buildBodyAccessOwnershipSql({
        requestId: 'req_123',
        apiKeys: ['not-a-valid-key'],
      }),
    ).toBeNull();
  });

  it('verifies Tinybird ownership before minting a token', async () => {
    const ctx = makeIssueTokenCtx();

    const result = await (
      issueToken as unknown as {
        _handler: (
          ctx: ReturnType<typeof makeIssueTokenCtx>,
          args: { requestId: string },
        ) => Promise<{ token: string; expiresAt: number }>;
      }
    )._handler(ctx, { requestId: 'req_123' });

    expect(mocks.limit).toHaveBeenCalledWith(ctx, 'bodyAccessToken', {
      key: 'user_123',
      throws: true,
    });
    expect(mocks.runAdminSql).toHaveBeenCalledWith(
      expect.objectContaining({
        adminToken: 'test-tinybird-admin-token',
        baseUrl: 'https://api.us-west-2.aws.tinybird.co',
        sql: expect.stringContaining(`ApiKey IN ('${VALID_API_KEY}')`),
      }),
    );
    expect(mocks.runAdminSql.mock.calls[0]?.[0].sql).toContain(
      "JSONExtractString(SpanAttributes, 'gen_ai.request_id') = 'req_123'",
    );
    expect(result.token).toEqual(expect.any(String));
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects token minting when Tinybird has no matching request row', async () => {
    const ctx = makeIssueTokenCtx();
    mocks.runAdminSql.mockResolvedValueOnce([]);

    await expect(
      (
        issueToken as unknown as {
          _handler: (
            ctx: ReturnType<typeof makeIssueTokenCtx>,
            args: { requestId: string },
          ) => Promise<{ token: string; expiresAt: number }>;
        }
      )._handler(ctx, { requestId: 'req_missing' }),
    ).rejects.toThrow('Body access denied');
  });
});
