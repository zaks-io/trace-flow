# API Key Sanitization for Tinybird Queries

## Problem

API keys are passed as parameters to Tinybird queries via JWT tokens. The keys are joined into a comma-separated string in `packages/convex/integrations/tinybird.ts` and passed to Tinybird's `fixed_params.api_keys`. If a malicious API key value contains SQL metacharacters, it could potentially inject SQL into Tinybird queries.

## Current Flow

1. User creates API keys stored in Convex `apiKeys` table
2. `packages/convex/integrations/tinybird.ts` fetches keys via `listForUser`, sanitizes UUID-shaped values, and joins them for `fixed_params.api_keys`
3. JWT token includes `fixed_params: { api_keys: 'key1,key2,key3' }`
4. Tinybird pipes use: `WHERE ApiKey IN splitByChar(',', {{ String(api_keys, '') }})`

Agent analytics does not use this API-key path. Collector uploads authenticate with hidden Collector
Credentials, and agent Tinybird pipes use `fixed_params.org_id`. Collector Credential IDs and secrets
must never be added to `fixed_params.api_keys` or API-key dashboard filters.

## Risk Assessment

- **Injection point**: The `api_keys` string flows directly into ClickHouse SQL
- **Attack vector**: User-controlled API key values during key creation
- **Severity**: High - could allow data exfiltration or query manipulation

## Implementation

### 1. API Key Validation at Creation

**File**: `packages/convex/apiKeys.ts`

Add validation when creating/updating API keys:

```typescript
const API_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_KEY_LENGTH = 64;

function validateApiKey(key: string): void {
  if (!key || key.length > MAX_KEY_LENGTH) {
    throw new Error('API key must be 1-64 characters');
  }
  if (!API_KEY_PATTERN.test(key)) {
    throw new Error('API key may only contain alphanumeric characters, underscores, and hyphens');
  }
}
```

### 2. Sanitization at Token Generation

**File**: `packages/convex/integrations/tinybird.ts`

Keys are `crypto.randomUUID()` strings in practice. Before building the JWT, only values matching a strict UUID regex are included (defense in depth for anything non-conforming in the DB):

```typescript
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeApiKeys(keys: string[]): string[] {
  return keys.filter((k) => UUID_PATTERN.test(k));
}

export function joinSanitizedApiKeys(apiKeys: { key: string }[]): string {
  return sanitizeApiKeys(apiKeys.map((k) => k.key)).join(',');
}

async function getApiKeyString(ctx: ActionCtx, userId: Id<'users'>): Promise<string> {
  const apiKeys = await ctx.runQuery(internal.apiKeys.listForUser, { userId });
  return joinSanitizedApiKeys(apiKeys);
}
```

### 3. Parameterized Queries in Tinybird

Audit all Tinybird pipes to ensure they use parameterized queries properly:

**Files to audit**:

- `pipes/traces_summary.pipe`
- `pipes/traces_list.pipe`
- `pipes/trace_detail.pipe`
- `pipes/llm_usage_*.pipe`
- `pipes/agent_*.pipe` for the opposite invariant: they must filter by `org_id`, not `api_keys`

Current pattern (safe when combined with sanitization):

```sql
WHERE ApiKey IN splitByChar(',', {{ String(api_keys, '') }})
```

## Testing

### Unit Tests

**File**: `convex/__tests__/apiKeys.test.ts`

```typescript
describe('API Key Validation', () => {
  it('rejects keys with SQL metacharacters', () => {
    expect(() => validateApiKey("key'; DROP TABLE--")).toThrow();
  });

  it('rejects keys with commas', () => {
    expect(() => validateApiKey('key1,key2')).toThrow();
  });

  it('accepts valid alphanumeric keys', () => {
    expect(() => validateApiKey('my_api-key_123')).not.toThrow();
  });
});
```

### Integration Tests

- Attempt to create API key with injection payload, verify rejection
- Verify existing keys are sanitized when generating tokens
- Verify Tinybird queries work correctly with sanitized keys

## Migration

1. Audit existing API keys in database for invalid characters
2. If invalid keys exist, decide: sanitize in place or notify users
3. Run validation script to report any problematic keys before enforcing

## Acceptance Criteria

- [ ] API key creation validates against allowed character set
- [ ] Token generation sanitizes all keys before inclusion
- [ ] All Tinybird pipes audited and documented
- [ ] Agent Tinybird pipes filter by `org_id` and never by Collector Credential or API key identity
- [ ] Unit tests for validation and sanitization
- [ ] Integration tests for end-to-end flow
- [ ] Migration plan for existing data
