# Frontend-Direct Queries with JWT Authentication

Trace Flow's dashboard queries Tinybird directly from the browser using short-lived JWT tokens. This document explains why we chose this architecture over a backend proxy and how we implement row-level security.

## The Problem

The dashboard needs to display real-time trace analytics: request counts, token usage, latency distributions, and individual trace details. The simplest approach would be to proxy all queries through our backend:

```
Browser → Convex Action → Tinybird → Response → Convex Action → Browser
```

This adds latency to every query (two extra network hops) and puts load on our Convex backend. Dashboard pages make 5-10 Tinybird queries on load. Polling for updates multiplies this further.

However, we cannot give the frontend a static Tinybird admin token. That would expose all users' data to anyone who inspects network requests.

## The Solution

We use Tinybird's JWT authentication to generate short-lived tokens with scoped permissions:

1. Frontend requests a token from Convex
2. Convex generates a JWT signed with the admin token
3. JWT contains scopes limiting which pipes can be called and what data can be accessed
4. Frontend calls Tinybird directly with the JWT
5. Tinybird validates the JWT and enforces the scopes

```
Browser → Tinybird (with JWT)

(Token acquisition, happens once per session)
Browser → Convex → JWT → Browser
```

## JWT Token Structure

The Convex action generates tokens with this structure:

```typescript
const payload = {
  workspace_id: 'your-workspace-id',
  name: `convex_jwt_${Date.now()}`,
  scopes: [
    {
      type: 'PIPES:READ',
      resource: 'traces_list',
      fixed_params: {
        api_keys: 'key1,key2,key3',
      },
    },
  ],
};
```

**workspace_id**: Identifies the Tinybird workspace. Required for multi-tenant Tinybird.

**scopes**: Array of permissions. Each scope specifies:

- `type`: Permission type (`PIPES:READ` for query access)
- `resource`: Pipe name the token can access
- `fixed_params`: Parameters injected into every query (row-level security)

### Scope allowlist (TRA-128)

`generateToken` and `generateTokenInternal` reject any scope that is not `PIPES:READ` on a
dashboard/MCP-callable pipe from `ALLOWED_TINYBIRD_PIPE_RESOURCES`. This blocks `DATASOURCES:*`
and `SQL:*` scopes: those permission types enforce row security via Tinybird JWT `filter` (SQL
WHERE), not `fixed_params`, so a caller could otherwise read raw datasources across tenants.

The allowlist is **not** every file in `pipes/` — helper/materialization pipes (e.g.
`agent_priced_usage`, no `TYPE ENDPOINT`) are excluded even when shipped. Every mintable pipe must
be `TYPE ENDPOINT` and filter on `api_keys` or `org_id` via JWT `fixed_params` (validated in
`__tests__/tinybirdPipeValidation.ts`). Update `tinybirdScopes.ts` when adding a new user-facing
endpoint the dashboard or MCP will query via JWT.

## Row-Level Security with fixed_params

Multi-tenant isolation is critical. Users must only see traces for API keys they are allowed to use (same scope as the API keys page: org keys plus their own keys).

Every Tinybird pipe includes an `api_keys` parameter in its WHERE clause:

```sql
SELECT * FROM otel_trace_spans
WHERE ApiKey IN splitByChar(',', {{ String(api_keys, '') }})
```

When generating a JWT, Convex fetches API keys visible to the user (`listForUser`, same as the dashboard) and injects them as `fixed_params`:

```typescript
const apiKeys = await ctx.runQuery(internal.apiKeys.listForUser, { userId });
const apiKeyString = joinSanitizedApiKeys(apiKeys);

const scopesWithApiKeys = args.scopes.map((scope) => ({
  ...scope,
  fixed_params: {
    ...scope.fixed_params,
    api_keys: apiKeyString || '__NO_KEYS__',
  },
}));
```

The `__NO_KEYS__` sentinel prevents users with no API keys from accidentally matching empty strings.

Tinybird enforces `fixed_params` server-side. Even if a malicious frontend modifies the request, it cannot override the API key filter embedded in the JWT.

## Token Lifecycle

**TTL (Time To Live)**: Tokens expire after 10 minutes by default. This limits the damage window if a token is leaked.

```typescript
const ttlSeconds = args.ttl ?? 600;
const expirationTime = Math.floor(Date.now() / 1000) + ttlSeconds;
```

**Auto-refresh**: The frontend React hook detects 403 responses (expired token) and automatically fetches a fresh token:

```typescript
if (err instanceof TinybirdAuthError && jwt !== null) {
  setJwt(null);
  const freshToken = await fetchToken();
  const result = await fetchData(freshToken);
  // ...
}
```

**Token caching**: The hook caches the current JWT and reuses it until expiration. No token fetch on every query.

## Scope Granularity

Each token is scoped to specific pipes. The frontend requests scopes based on which queries it needs:

```typescript
const { data } = useTinybirdPipe({
  pipe: 'traces_summary',
  params: { start_time_ns: startTime },
});

// Internally requests token with:
// scopes: [{ type: 'PIPES:READ', resource: 'traces_summary' }]
```

A compromised token for `traces_summary` cannot query `traces_list` or other pipes.

## Benefits

**Low latency**. Browser-to-Tinybird is one network hop. Dashboard queries complete in 50-200ms instead of 300-500ms through a proxy.

**Reduced backend load**. Convex handles token generation (once per session) instead of proxying every query. Token generation is a lightweight crypto operation.

**Scalable**. Tinybird handles query load directly. We do not need to scale proxy infrastructure as dashboard usage grows.

**Security in depth**. Multiple layers protect data:

1. JWT signature verification (prevents forgery)
2. Short expiration (limits leak window)
3. Pipe-level scopes (limits query surface)
4. fixed_params (enforces row-level filtering)

## Implementation Details

### Convex Token Generation

The `tinybird.ts` action handles token creation:

```typescript
export const generateToken = action({
  args: {
    scopes: v.array(
      v.object({
        type: v.string(),
        resource: v.string(),
        fixed_params: v.optional(v.record(v.string(), v.any())),
      }),
    ),
    ttl: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);

    const user = await ctx.runQuery(api.users.getCurrentUserQuery, {});
    const apiKeyString = user ? await getApiKeyString(ctx, user._id) : '';

    assertMintableTinybirdScopes(args.scopes);

    // Inject api_keys into all scopes
    const scopesWithApiKeys = args.scopes.map((scope) => ({
      ...scope,
      fixed_params: { ...scope.fixed_params, api_keys: apiKeyString || '__NO_KEYS__' },
    }));

    const token = await new SignJWT({
      workspace_id: workspaceId,
      name: `convex_jwt_${Date.now()}`,
      scopes: scopesWithApiKeys,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(expirationTime)
      .sign(secret);

    return { token, expiresAt: expirationTime };
  },
});
```

### Frontend Hook

The `useTinybirdPipe` hook manages the token lifecycle:

```typescript
export function useTinybirdPipe<T>(options: UseTinybirdPipeOptions<T>) {
  const [jwt, setJwt] = useState<string | null>(null);
  const generateToken = useAction(api.tinybird.generateToken);

  const fetchToken = useCallback(async () => {
    const result = await generateToken({
      scopes: [{ type: 'PIPES:READ', resource: options.pipe }],
      ttl: options.ttl,
    });
    setJwt(result.token);
    return result.token;
  }, [generateToken, options.pipe, options.ttl]);

  const fetchData = useCallback(
    async (token: string) => {
      const response = await fetch(`${apiUrl}/v0/pipes/${pipe}.json?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // Handle 403 → refresh token
      // ...
    },
    [pipe, params],
  );

  // ...
}
```

## Why 10-Minute Token TTL

The 10-minute default balances security and usability:

**Shorter (1-5 minutes)**: More frequent token refreshes. Better security but adds latency spikes when tokens expire mid-session.

**Longer (30-60 minutes)**: Fewer refreshes but larger window for token abuse if leaked. User session changes (logout, API key revocation) take longer to reflect.

10 minutes means:

- A stolen token is useful for at most 10 minutes
- Active dashboard sessions refresh tokens ~6 times per hour
- API key changes propagate within 10 minutes

## Trade-offs

**Token fetch latency**. The first query on page load waits for token generation. This adds ~100-200ms to initial load.

**Convex dependency for auth**. If Convex is down, new tokens cannot be generated. Cached tokens continue working until expiration.

**Scope management**. Each pipe needs its own scope request. Pages querying many pipes make larger token requests.

**JWT size**. Tokens with many scopes or long API key lists become large. We compress API keys into a comma-separated string.

## Alternative Considered: Backend Proxy

A backend proxy would simplify authentication (one secret server-side) but:

1. **Latency penalty**: Every query adds 50-100ms for the extra hop through Convex
2. **Backend load**: Dashboard queries become Convex load, requiring more capacity
3. **Streaming complexity**: Tinybird supports streaming responses for large datasets; proxying streams through Convex is complex

The JWT approach provides equivalent security with better performance.

## Conclusion

Frontend-direct queries with scoped JWTs provide the best balance of security, performance, and simplicity for our dashboard. Row-level security via `fixed_params` ensures multi-tenant isolation without trusting the frontend. Short token TTLs limit exposure. The result is a responsive dashboard that scales independently of our backend.
