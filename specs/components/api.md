# API Worker

The API Worker provides a secure endpoint for retrieving request and response bodies stored in R2. It serves as the bridge between the web dashboard and the raw data captured by the proxy.

## What It Does

The API worker exposes a single endpoint that retrieves request or response bodies from R2 storage. It validates Auth0 JWT tokens to ensure only authenticated users can access body data.

## Why a Separate Worker

The proxy worker stores bodies in R2 but cannot serve them directly because:

1. **Authentication Model**: The proxy uses API key auth for LLM requests, but the web dashboard uses Auth0 JWT tokens. Mixing auth schemes in one worker adds complexity.

2. **Separation of Concerns**: The proxy is optimized for low-latency forwarding with async storage. Adding synchronous reads would complicate its architecture.

3. **CORS Requirements**: The web dashboard needs CORS headers to fetch from a different origin. The proxy strips headers for forwarding, making CORS handling awkward.

4. **Security Boundary**: Keeping body retrieval separate limits the attack surface. The API worker only reads from R2; it cannot write or modify data.

## Endpoint

```
GET /bodies/:requestId/:type
```

**Parameters**:

- `requestId`: The unique identifier from the trace (maps to R2 key)
- `type`: Either `request` or `response`

**Response**:

- `200`: Body content with appropriate Content-Type
- `400`: Missing or invalid parameters
- `401`: Missing or invalid JWT
- `403`: User lacks required role
- `404`: Body not found in R2

## Authentication

The worker validates Auth0 JWT tokens using public key verification:

1. Extracts token from `Authorization: Bearer <token>` header
2. Fetches JWKS from Auth0's well-known endpoint
3. Verifies signature using RS256 algorithm
4. Validates `iss` (issuer) and `aud` (audience) claims
5. Checks for `Trace Flow` role in `neuron/roles` claim

**JWKS Caching**: The JWKS (JSON Web Key Set) is cached per domain to avoid repeated network calls. This saves 200-400ms per request after the first fetch.

**Token Expiry**: Expired tokens return a 401 with a clear message, allowing the frontend to refresh and retry.

## CORS Configuration

The worker allows requests from specific origins:

- `http://localhost:4321` - Local Astro dev
- `http://localhost:4322` - Alternative local port
- `http://localhost:8788` - Local workers dev
- `https://trace-flow.dev` - Production
- `https://trace-flow-web.pages.dev` - Pages deployment
- `https://trace-flow-web-preview.pages.dev` - Preview deployments

Only `GET` and `OPTIONS` methods are allowed.

## R2 Key Mapping

Bodies are stored with predictable keys:

| Type     | R2 Key Pattern          |
| -------- | ----------------------- |
| Request  | `requests/{requestId}`  |
| Response | `responses/{requestId}` |

The `requestId` comes from the trace's `gen_ai.request_id` attribute.

## Error Handling

The worker returns structured JSON errors:

```json
{
  "error": "Token expired",
  "message": "The provided JWT has expired"
}
```

Error types:

- `Missing authorization` (401): No Authorization header
- `Invalid authorization format` (401): Header present but malformed
- `Token expired` (401): JWT past expiration time
- `Invalid token` (401): Signature verification failed
- `Insufficient permissions` (403): Missing required role
- `Server configuration error` (500): Auth0 env vars missing

## Sentry Integration

The worker is wrapped with Sentry for error monitoring. All unhandled exceptions are captured with:

- Release version from CF_VERSION_METADATA
- Environment tag (development/production)
- 10% trace sampling rate

## Bindings

| Binding           | Type      | Purpose                       |
| ----------------- | --------- | ----------------------------- |
| `STORAGE`         | R2 Bucket | Reads request/response bodies |
| `AUTH0_DOMAIN`    | Variable  | Auth0 tenant domain           |
| `AUTH0_CLIENT_ID` | Variable  | Auth0 application client ID   |

## Key Files

- `workers/api/src/index.ts` - Hono application with single endpoint
- `workers/api/src/auth.ts` - JWT validation with JWKS caching
