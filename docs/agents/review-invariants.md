# Trace Flow Review Invariants

Repo-specific review rules for `ziw-code-review` (the org skill's bug taxonomy is
generic; these are the traps that have actually bitten this codebase). Load this alongside
the skill's checklist when reviewing Trace Flow diffs or PRs.

## CF Workers stream handling

- **Always `tee()` request/response streams; both branches must be consumed.** CF Workers
  streams are read-once. If one tee branch is dropped, the Worker hangs. Flag any capture
  path that reads a stream without ensuring both consumers run.
- **Defer R2 storage + queue enqueue with `c.executionCtx.waitUntil()`.** Without it the
  Worker terminates before async ops finish → silent data loss. Flag async capture work that
  is not wrapped in `waitUntil()`.

## Queue consumer

- **Consumer must call `message.ack()` after processing.** A missing `ack()` causes
  redelivery loops. Flag any batch handler path that returns without acking processed
  messages.

## Tinybird / ClickHouse schema

- `LowCardinality(String)` for enums / low-cardinality strings (< 10k unique).
- Avoid `Nullable` — it adds a UInt8 column and degrades performance.
- Sorting-key order matters 10–100x; highest-cardinality filter columns first.
- Every datasource has a `_quarantine` table; rows that don't match schema land there.
- Use `FORWARD_QUERY` for zero-downtime migrations; validate with `tb build`.
- Flag schema changes that add `Nullable`, reorder sorting keys without justification, or
  skip `_quarantine`/migration considerations.

## Convex auth boundary

- JWT is signed in a Convex action with the admin token (HS256) and includes `fixed_params`.
- The admin token must never reach the frontend. Tokens expire after 10 min; 403 triggers
  auto-refresh. Flag any path that exposes the admin token or signs tokens client-side.
- Dev only: `bunx convex dev --once`. Never `convex deploy` or mutate Convex env vars
  (`convex deploy` is hook-blocked).

## Secret-redaction boundary

- Secrets, tokens, credentials, customer payloads, and signed URLs must be redacted before
  they enter model context, logs, the tracker, or PR bodies. Flag any new code path that
  logs or forwards raw request/response bodies without redaction.

## Required bindings

- Worker bindings stay **required**, not defensively optional. Misconfigs should fail loud
  at startup, not degrade silently. Flag new optional/guarded bindings that hide
  misconfiguration.

## R2 body keys

- Single object per request: `bodies/${requestId}` holds both request and response. Flag
  divergence from this key shape.

## Error handling

- Log errors before returning HTTP error responses — never return errors silently.

## CodeRabbit escalation rubric

CodeRabbit is on-demand only (auto + incremental disabled in `.coderabbit.yaml`). Default to
SKIP after a clean local review. Escalate (CLI `coderabbit review --agent` or
`@coderabbitai review` PR comment) only for genuinely high-risk changes:

- auth, secrets, or credential handling
- destructive data paths
- Tinybird or Convex schema changes
- queue concurrency / ack behavior
- proxy streaming or capture (`tee`/`waitUntil`)
- public contracts (`@trace-flow/types`)
- broad refactors, or unresolved local-review uncertainty
