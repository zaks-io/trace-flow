# Read-Side Secret Boundaries

Status: implemented by `apps/pipes-api` (Tinybird Pipe forwarding) and `apps/api` (Raw API Body Object retrieval).

Before this split, Trace Flow's read side had one **API Worker** (`apps/api`) serving two different surfaces:

- Body Object retrieval for the Web app.
- Tinybird Pipe passthrough for dashboard analytics queries.

This document records the target architecture for splitting that read side by secret boundary rather than by code size.

## The Problem

The current Worker is small, but it combines unrelated privilege classes in one isolate:

- R2 read access for Body Objects.
- `BODY_ENCRYPTION_ROOT_KEY` for decrypting encrypted Body Objects.
- `BODY_ACCESS_JWT_SECRET` for verifying short-lived, request-scoped Body Object access tokens.
- KV subscription data for current retention checks.
- Tinybird Pipe passthrough code.
- `TINYBIRD_ADMIN_TOKEN`, currently used to verify Tinybird JWTs before forwarding.

If an attacker, compromised dependency, or over-capable agent workflow gets access to Worker memory, the blast radius spans both raw captured data and Tinybird admin-token authority. The code is not large enough to justify a split for maintainability alone, but the secret boundary is too broad.

The Tinybird admin token is especially sensitive. It signs scoped **Pipe Tokens** and can perform administrative Tinybird operations. It should not be present in a public read-side Worker that also holds raw-object access.

## Decision

Split the read-side surfaces by secret class:

1. **Convex is the only user-token minting authority.**
   Convex owns `TINYBIRD_ADMIN_TOKEN` for user-scoped Pipe Token creation and any server-side Tinybird admin operations. Public Workers do not mint or verify Tinybird JWTs with the admin token.

2. **`pipes.trace-flow.dev` serves Tinybird Pipe passthrough.**
   This Worker forwards bearer Pipe Tokens to Tinybird, rate-limits requests, logs, and may cache responses. It does not bind R2, KV org membership, Auth0 configuration, `BODY_ENCRYPTION_ROOT_KEY`, or `TINYBIRD_ADMIN_TOKEN`.

3. **`raw.trace-flow.dev` serves sensitive raw-object reads.**
   This Worker retrieves raw stored artifacts such as Body Objects now and, if shipped later, Raw Session Bundles. It may bind R2, `BODY_ENCRYPTION_ROOT_KEY`, `BODY_ACCESS_JWT_SECRET`, subscription KV data, and a raw-object rate limiter. It does not bind Tinybird admin credentials or Tinybird query forwarding logic.

4. **Do not preserve `api.trace-flow.dev` as the canonical read-side origin.**
   Separate origins make the security model visible in URLs, CSP, Cloudflare bindings, logs, and operational runbooks. Backward-compatible redirects or aliases can exist temporarily if needed, but new Web configuration should use explicit `pipes` and `raw` origins.

## Target Request Flow

Pipe query flow:

```text
Web -> Convex action -> scoped Pipe Token
Web -> pipes.trace-flow.dev/v0/pipes/* -> Tinybird
```

Raw object flow:

```text
Web -> Convex action -> short-lived Body Access Token
Web -> raw.trace-flow.dev/bodies/:requestId -> R2 Body Object
```

Future raw transcript flow, if shipped:

```text
Web -> Convex action -> short-lived raw-object token
Web -> raw.trace-flow.dev/agent-sessions/:sessionId/raw -> R2 Raw Session Bundle
```

## CSP And Browser Boundary

The Web app should allow only the exact read origins it needs:

- `connect-src https://pipes.trace-flow.dev` for analytics queries.
- `connect-src https://raw.trace-flow.dev` for sensitive raw-object fetches.

The raw surface can carry stricter headers and CORS behavior than the pipe surface. For example, raw reads should remain non-embeddable, origin-restricted, and privately cached only where explicitly intended.

## Consequences

### Benefits

- A compromise of the Pipe passthrough Worker does not expose R2 or raw body decryption material.
- A compromise of the raw-object Worker does not expose the Tinybird admin token.
- Convex remains the control-plane source of truth for user, Organization, API-key visibility, retention, and Pipe Token minting.
- The browser, CSP, and Cloudflare bindings reflect the architecture directly.
- Future raw artifacts can live behind the same sensitive raw-object seam without widening the Pipe Worker.

### Costs

- More Worker deploy units and Cloudflare route configuration.
- More Web environment variables: separate pipe and raw API origins.
- Docs, preview configuration, and local-dev scripts need updates.
- Pipe proxy cache keys may need to avoid admin-token verification. If it cannot inspect JWT fixed params without the admin token, cache keys should use token hash or another non-secret caller scope. Reduced cache sharing is acceptable to remove the admin token from the Worker.

## Migration Plan

1. Remove `TINYBIRD_ADMIN_TOKEN` from `apps/api` Pipe passthrough. Forward bearer tokens to Tinybird and let Tinybird validate them.
2. Add Web configuration for separate read origins:
   - `NEXT_PUBLIC_PIPES_API_URL`
   - `NEXT_PUBLIC_RAW_API_URL`
     Both may initially default to `NEXT_PUBLIC_API_URL`.
3. Split `apps/api` into two deploy units:
   - Pipe Worker for `pipes.trace-flow.dev`.
   - Raw Worker for `raw.trace-flow.dev`.
4. Update CSP, CORS, Wrangler config, local-dev scripts, docs, and tests.
5. Remove `TINYBIRD_ADMIN_TOKEN` from any public Worker secret set.

## Done

- No public Worker binds both raw-object credentials and Tinybird query forwarding.
- No public Worker binds `TINYBIRD_ADMIN_TOKEN`.
- Convex remains the only holder of `TINYBIRD_ADMIN_TOKEN` for user Pipe Token minting.
- Web uses `pipes.trace-flow.dev` for Pipe queries and `raw.trace-flow.dev` for raw-object reads.
- Tests cover both read surfaces independently.
