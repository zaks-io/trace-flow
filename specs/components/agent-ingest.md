# Agent Ingest Worker

The Agent Ingest Worker is the public collector intake boundary for Agent Conversation Analytics. It accepts parsed fact envelopes from Trace Flow CLI/Desktop, authenticates the Collector Credential, validates the upload, stamps tenancy and stable row identities, claims Agent Session ownership, and enqueues agent fact messages.

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
10. Chunks facts into sub-128 KiB queue messages and calls `AGENT_QUEUE.sendBatch`.

## What It Does Not Do

- It does not calculate price.
- It does not write Tinybird rows.
- It does not authenticate user-facing API keys.
- It does not proxy LLM requests.
- It never stores or forwards raw transcript content. Fact envelopes have no raw-upload slots; the planned lossless path belongs to the separately authorized Archive API.

## Bindings

| Binding                      | Type       | Purpose                                            |
| ---------------------------- | ---------- | -------------------------------------------------- |
| `COLLECTOR_CREDS`            | KV         | Convex-synced Collector Credential hash lookup     |
| `AGENT_QUEUE`                | Queue      | Agent fact message producer                        |
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
- `503`: compatibility policy, session claim, or queue enqueue is unavailable

Retryable failures do not advance collector cursors. The collector resubmits and the downstream fact ledger dedupes stable row identities.

## Key Files

- `apps/agent-ingest/src/index.ts` - Hono app and Sentry wrapper
- `apps/agent-ingest/src/handler.ts` - `/v1/ingest` flow
- `apps/agent-ingest/src/auth.ts` - Collector Credential lookup
- `apps/agent-ingest/src/policy.ts` - Convex compatibility policy
- `apps/agent-ingest/src/ownership.ts` - Agent Session ownership claims
- `apps/agent-ingest/src/ids.ts` - stable ID assembly
- `apps/agent-ingest/src/chunker.ts` - queue message splitting
- `apps/agent-ingest/src/redaction.ts` - server-side redaction backstop
