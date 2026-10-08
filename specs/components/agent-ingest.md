# Agent Ingest Worker

The Agent Ingest Worker is the public collector intake boundary for Agent Conversation Analytics. It accepts parsed fact envelopes from Trace Flow CLI/Desktop, authenticates the Collector Credential, validates the upload, stamps tenancy and stable row identities, claims Agent Session ownership, stores encrypted fact deliveries in R2, and enqueues their references.

Agent analytics is still not production-ready until the gates in `docs/guides/agent-conversation-analytics/ROADMAP.md` are complete.

## What It Does

1. Accepts `POST /v1/ingest` from collectors.
2. Authenticates `X-Trace-Flow-Collector-Secret` against `COLLECTOR_CREDS`.
3. Fetches the Convex compatibility policy for desktop/parser versions.
4. Applies the per-org `AGENT_INGEST_LIMITER`.
5. Inflates gzip bodies and enforces request-size caps.
6. Validates the `AgentIngestEnvelope` shape.
7. Re-redacts free-text excerpts as a server-side backstop.
8. Assembles `session_pk`, row `*_pk` values, and `repo_fingerprint`.
9. Claims first-writer session ownership through Convex.
10. Splits facts into bounded encrypted R2 deliveries using stable collector retry identities.
11. Registers each delivery with the organization coordinator to reserve its acceptance revision.
12. Calls `AGENT_QUEUE.sendBatch` with small `AgentDeliveryReference` messages.

## What It Does Not Do

- It does not calculate price.
- It does not write Tinybird rows.
- It does not authenticate user-facing API keys.
- It does not proxy LLM requests.
- It never stores or forwards raw transcript content. Fact envelopes have no raw-upload slots.

## Bindings

| Binding                      | Type       | Purpose                                            |
| ---------------------------- | ---------- | -------------------------------------------------- |
| `COLLECTOR_CREDS`            | KV         | Convex-synced Collector Credential hash lookup     |
| `AGENT_QUEUE`                | Queue      | Agent delivery reference producer                  |
| `AGENT_DELIVERIES`           | R2         | Encrypted bounded fact deliveries                  |
| `AGENT_CONSUMER`             | Service    | Delivery registration and admission checks         |
| `BODY_ENCRYPTION_ROOT_KEY`   | Secret     | Delivery encryption                                |
| `AGENT_INGEST_LIMITER`       | RateLimit  | Per-org burst guard                                |
| `CONVEX_SITE_URL`            | Secret/var | Compatibility policy and session ownership routes  |
| `AGENT_INGEST_SHARED_SECRET` | Secret     | Authenticates worker-to-Convex agent ingest routes |
| `SENTRY_DSN`                 | Secret     | Error monitoring                                   |

## Failure Semantics

- `401`: invalid or revoked Collector Credential
- `400`: malformed JSON, invalid gzip, or invalid envelope shape
- `413`: request exceeds body-size limits
- `426`: collector desktop/parser version is unsupported
- `429`: org ingest burst limit exceeded
- `503`: compatibility policy, session claim, durable staging, or queue enqueue is unavailable; snapshot admission closure returns `Retry-After: 60`

Retryable failures do not advance collector cursors. Retries within one POST cycle reuse the collector
batch identity and the registered delivery receipt. Later deliveries replace matching canonical fact
identities through their accepted revision. The existing 124,000-byte chunk bound remains part of the
retry identity; fact bodies travel in R2 rather than inline queue messages.

## Key Files

- `apps/agent-ingest/src/index.ts` - Hono app and Sentry wrapper
- `apps/agent-ingest/src/handler.ts` - `/v1/ingest` flow
- `apps/agent-ingest/src/auth.ts` - Collector Credential lookup
- `apps/agent-ingest/src/policy.ts` - Convex compatibility policy
- `apps/agent-ingest/src/ownership.ts` - Agent Session ownership claims
- `apps/agent-ingest/src/ids.ts` - stable ID assembly
- `apps/agent-ingest/src/chunker.ts` - bounded fact splitting
- `apps/agent-ingest/src/retry-request.ts` - collector batch identity manifests
- `apps/agent-ingest/src/redaction.ts` - server-side redaction backstop
