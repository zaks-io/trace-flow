# Code Review Checklist

Use this as a bug taxonomy, not as a script to recite. State zero-finding categories only when useful
for the final verdict.

## Severity

- P0: exploit, data loss, irreversible destructive action, credential exposure, or guaranteed outage.
- P1: correctness, security, authorization, migration, concurrency, or API-contract bug that can break
  a real workflow.
- P2: important regression, missing edge-case handling, test gap around risky behavior, or
  maintainability issue with clear failure mode.
- P3: style, naming, preference, or optional cleanup. Suppress by default.

## Evidence Gate

Before reporting a finding:

1. Quote or cite the exact source line that creates the risk.
2. Explain the concrete failure path, not just the pattern name.
3. Check for framework or repo conventions that intentionally handle it elsewhere.
4. Assign confidence from 1 to 10.
5. Suppress findings below confidence 5 unless impact would be P0/P1.

Confidence guide:

- 9-10: verified by reading source and the failure is concrete.
- 7-8: high-confidence pattern with enough local evidence.
- 5-6: plausible but needs maintainer verification; keep concise.
- 3-4: suspicious but too speculative for the main report.
- 1-2: do not report unless catastrophic.

## Critical Categories

### Scope and intent

- Does the diff deliver the requested behavior?
- Are acceptance criteria or issue requirements missing?
- Are unrelated refactors, formatting sweeps, or package changes mixed in?
- Did tests/docs/status ledgers change when the behavior contract changed?

### Auth, authorization, and secrets

- New route, command, worker, job, or API path lacks the expected auth gate.
- Authorization checks use identity but miss workspace, tenant, role, resource ownership, or
  capability scope.
- Tokens, session cookies, service credentials, or secrets are logged, returned to clients, written to
  artifacts, or committed.
- A "local only" or "admin only" path is reachable from production routing.

### Data safety and persistence

- Destructive update/delete lacks a `WHERE`, tenant/workspace filter, transaction, or idempotency key.
- Multi-step write can partially commit without rollback.
- Schema migration is not compatible with the code path being shipped.
- Retention, cleanup, or queue code can delete current or pinned data.
- New persisted fields are not validated, normalized, or bounded.

### SQL and query construction

- User-controlled values are interpolated into SQL, filters, object keys, sort keys, or column names
  without allowlisting.
- Query joins or filters omit tenant/workspace boundaries.
- Pagination or date filters are unstable, unbounded, or inconsistent.

### Concurrency and background work

- Read-modify-write happens without atomic update, transaction, version check, lock, or idempotency
  guard.
- Queue handlers assume one worker, one delivery, or no retry.
- Cron jobs or delayed work can overlap and double-apply effects.
- Async work continues after request context, transaction, or cancellation scope ends.

### API and contract compatibility

- Public request or response schema changed without corresponding client, CLI, docs, or tests.
- New enum/status/type value is not handled in every switch, serializer, parser, renderer, and CLI
  output path.
- Error shape, status code, retry behavior, or pagination semantics changed accidentally.
- Generated artifacts are stale.

### LLM and untrusted output

- Model output is trusted as code, SQL, shell input, HTML, file path, API operation, or DB row without
  schema validation and escaping.
- Prompt assembly lets user text override system or developer instructions.
- Parser assumes the model always returns valid JSON, required fields, or bounded text.
- Failure, refusal, rate-limit, or timeout path is missing.

### Shell, filesystem, and path safety

- Shell command uses interpolated strings instead of argv arrays.
- File paths from user, archive, API, model, or config input are not normalized and checked against an
  allowed root.
- Temp files can collide, leak, or be read before write completion.
- Archive extraction allows traversal or oversized files.

### Frontend and rendering

- User or model content is rendered as raw HTML or unsafe markdown.
- Client/server boundary leaks secrets or privileged data.
- Loading, empty, error, and permission states are missing for new user-facing flows.
- Form validation differs between client and server in a way that can bypass server rules.

### Time, money, and external systems

- Time comparisons mix local time and UTC, ignore DST, or use non-monotonic clocks for expiry.
- Payment, quota, metering, billing, or rate-limit changes lack idempotency and retry handling.
- External API calls ignore timeout, retry, partial failure, backoff, or duplicate delivery behavior.

### Configuration and operational limits

- Numeric config changes lack a reason tied to production load, upstream/downstream limits, or measured
  behavior.
- Connection pools, worker counts, queue depths, cache sizes, timeouts, retries, and rate limits
  changed without considering the full concurrency path.
- Debug flags, verbose logging, wildcard hosts/origins, admin endpoints, or management routes can reach
  production.
- Rollback and monitoring signals are unclear for a risky config change.

### Tests and verification

- Risky behavior lacks a test that would fail for the bug being reviewed.
- Tests assert implementation details while missing user-visible behavior.
- Tests pass only in local order or share state across cases.
- Smoke or integration checks are skipped where the changed path is cross-package or
  runtime-dependent.

## Trace Flow specifics

This is an LLM-observability platform on Cloudflare Workers (Proxy, Consumer, API, Web) plus Tinybird
and Convex. Beyond the generic taxonomy, check:

- **Streams:** any new response path must `tee()` and consume **both** streams — an unconsumed stream
  hangs the Worker. Capture/transform must not block the client response.
- **Deferred work:** R2 writes and queue enqueues belong in `c.executionCtx.waitUntil()`, never inline
  before the response returns. Missing `waitUntil()` drops data; awaiting it adds latency.
- **Queue consumer:** every processed message must `message.ack()` (or be retried/dead-lettered
  deliberately). A consumer that throws mid-batch without acking re-delivers the whole batch.
- **Worker bindings are required** — no defensive optional bindings. A missing binding must fail
  loudly, not silently no-op.
- **Errors are logged before any HTTP error response** is returned — no silent failures. (Parsers that
  degrade gracefully on bad input are a separate, acceptable case.)
- **Tinybird/ClickHouse schema:** `LowCardinality(String)` for low-cardinality enums; avoid `Nullable`
  (`cost_usd` is the only allowed Nullable column — sparse metrics use `0` plus coverage columns);
  sorting-key column order matters 10-100x; prefer `FORWARD_QUERY` for zero-downtime migration. A new
  `.datasource`/`.pipe` must `tb build` cleanly.
- **Collector facts** ship tokens + model only — never a `cost_usd` and never a final `*_pk` (pricing
  and identity are server-side). No stored `agent_file_events` path may contain a home dir or username
  (outside-repo paths collapse to the `outside_repo` sentinel).
- **Redaction** is a trust boundary: the parser drops/masks secrets and the ingest Worker re-runs the
  same canary corpus as a backstop. Both layers must agree; a redaction change that touches only one
  side is a P1.
- **Convex:** dev uses `bunx convex dev --once` only — `convex deploy` and env-var edits are forbidden
  (and hook-blocked). Flag any code or doc that calls them.
- **Shared contracts:** changes to `@trace-flow/types` or the Rust `collector-contracts` are a
  cross-worker contract change — verify every producer/consumer and the round-trip fixture.

## CodeRabbit Escalation Rubric

CodeRabbit is on-demand only (automatic + incremental review are disabled in `.coderabbit.yaml`).

Recommend `SKIP` when the local review is clean and the change is docs-only, tests-only, copy/UI-only,
a mechanical rename, dependency metadata, or a small isolated bug fix with good tests.

Recommend `CLI` when the PR is not open yet and the change is high risk enough to benefit from another
model pass before publishing.

Recommend `PR REVIEW` when the PR is already open, the diff is broad, or review comments need to land
on GitHub threads.

Escalation triggers:

- Auth, authorization, secrets, data retention/deletion, Tinybird/Convex schema migrations, queue or
  consumer concurrency, or the proxy streaming/capture path.
- Cross-cutting refactor or public API / shared-type / `.datasource` contract change.
- Local review found P0/P1 issues and fixes were non-trivial.
- Reviewer uncertainty remains after reading the source and running focused checks.
- User explicitly asks for CodeRabbit on this PR.

When CodeRabbit runs, only act on high-priority findings. High-priority means P0/P1, security, data
loss, correctness regression, production blocker, or a finding the user specifically asks to address.
