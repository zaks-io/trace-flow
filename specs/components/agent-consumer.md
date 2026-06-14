# Agent Consumer Worker

The Agent Consumer Worker drains the agent ingest queue, prices message facts, maps typed facts into Tinybird rows, dedupes by stable fact identity, and writes the `agent_*` datasources used by `/app/agents`.

Agent analytics is still not production-ready until the gates in `docs/guides/agent-conversation-analytics/ROADMAP.md` are complete.

## What It Does

1. Receives batches from `agent-ingest-{env}`.
2. Validates each `AgentIngestQueueMessage`.
3. Prices Agent Message facts using the shared `MODEL_PRICING` KV catalog.
4. Maps facts into Tinybird row shapes for:
   - `agent_message_facts`
   - `agent_tool_event_facts`
   - `agent_file_event_facts`
   - `agent_capability_snapshot_facts`
   - `agent_pull_request_facts`
5. Routes rows by org to `AGENT_FACT_BATCHER`.
6. Flushes clean rows to Tinybird through the Events API.
7. Acknowledges messages only after the batch is safely accepted.

## AgentFactBatcher Durable Object

`AGENT_FACT_BATCHER` is an org-sharded Durable Object that stores a SQLite fact ledger before Tinybird insert:

- Exact duplicate fact identities with the same content hash are skipped.
- Same identity with a changed content hash is recorded as a repair signal.
- Pending rows stay in SQLite until Tinybird insert succeeds.
- Flushes happen at size threshold or on alarm.

This keeps duplicate queue redelivery from inflating counts and keeps query-time `FINAL` off the normal product path.

## Bindings

| Binding                     | Type           | Purpose                                  |
| --------------------------- | -------------- | ---------------------------------------- |
| `AGENT_QUEUE`               | Queue          | Agent ingest queue consumer              |
| `MODEL_PRICING`             | KV             | Shared model pricing catalog             |
| `AGENT_FACT_BATCHER`        | Durable Object | Fact ledger, dedupe, and insert batching |
| `TINYBIRD_TOKEN`            | Secret         | Tinybird Events API append token         |
| `TINYBIRD_HOST`             | Variable       | Tinybird regional API host               |
| `TINYBIRD_AGENT_WRITE_MODE` | Variable       | Clean, legacy, or dual write mode        |
| `SENTRY_DSN`                | Secret         | Error monitoring                         |

## Failure Semantics

- Malformed messages retry and eventually land in `agent-ingest-dlq-{env}`.
- Pricing misses leave `cost_usd` null when usage or pricing coverage is insufficient.
- Fact batcher failures retry every contributing message.
- Tinybird insertion failures leave rows pending in Durable Object SQLite for the next flush.

## Key Files

- `apps/agent-consumer/src/index.ts` - Queue handler and Sentry wrapper
- `apps/agent-consumer/src/consumer.ts` - batch processing and ack/retry behavior
- `apps/agent-consumer/src/pricing.ts` - model-cost lookup and calculation
- `apps/agent-consumer/src/rows.ts` - Tinybird row mapping
- `apps/agent-consumer/src/fact-batcher.ts` - Durable Object fact ledger
- `apps/agent-consumer/src/facts.ts` - datasource mappings and row identity fields
