# Agent Consumer Worker

The Agent Consumer Worker resolves encrypted agent deliveries, prices message facts once, writes
versioned canonical facts, and publishes bounded snapshots used by `/app/agents`.

Agent analytics is still not production-ready until the gates in
`docs/guides/agent-conversation-analytics/ROADMAP.md` are complete.

## What it does

1. Receives `AgentDeliveryReference` messages from `agent-ingest-{env}`.
2. Loads and validates each tenant-bound encrypted R2 delivery.
3. Prices Agent Message facts using the shared `MODEL_PRICING` KV catalog.
4. Stores an immutable encrypted row plan for retries.
5. Acquires an organization write permit and writes versioned facts to Tinybird.
6. Reconciles uncertain writes through delivery receipts.
7. Marks affected dates dirty and schedules snapshot work.
8. Acknowledges a reference only after its delivery completes.

The separate snapshot queue runs bounded Copy jobs. A manifest publishes captured dates only after
all nine snapshot targets succeed. Product endpoints read the latest published generation per date.

## Durable Objects

- `AgentDelivery` retains bounded delivery receipt metadata and retry progress.
- `AgentDeliveryCoordinator` assigns monotonically increasing revisions, serializes canonical writes,
  tracks dirty dates, and coordinates snapshot publication.
- `SnapshotCapacity` admits at most two snapshot generations globally.
- `AgentDeadLetters` preserves agent DLQ payloads in the shared `__dlq__` instance. Recovery uses
  shardId `"__dlq__"` and `retire-dead-letter` to resolve records while retaining their payloads.

Organization erasure fences new work, waits for admitted writes and Copy intents to settle, and
clears delivery buffers and matching shared dead letters. The organization coordinator retains its
permanent erasure fence. The retirement migration permanently deletes the old fact-ledger class and
all its storage; no legacy records are carried into the new dead-letter store.

## Bindings

| Binding                              | Type           | Purpose                                        |
| ------------------------------------ | -------------- | ---------------------------------------------- |
| `AGENT_QUEUE`                        | Queue          | Agent delivery references                      |
| `AGENT_SNAPSHOT_QUEUE`               | Queue          | Snapshot work                                  |
| `AGENT_DELIVERIES`                   | R2             | Encrypted delivery buffers and row plans       |
| `MODEL_PRICING`                      | KV             | Shared model pricing catalog                   |
| `AGENT_DELIVERY`                     | Durable Object | Delivery receipts and retry progress           |
| `AGENT_DELIVERY_COORDINATOR`         | Durable Object | Organization revisions and snapshots           |
| `AGENT_SNAPSHOT_CAPACITY`            | Durable Object | Global snapshot admission                      |
| `AGENT_DEAD_LETTERS`                 | Durable Object | Shared dead-letter preservation and recovery   |
| `TINYBIRD_TOKEN`                     | Secret         | Tinybird Events API append token               |
| `TINYBIRD_AGENT_DELIVERY_READ_TOKEN` | Secret         | Identity and receipt lookups                   |
| `TINYBIRD_AGENT_SNAPSHOT_TOKEN`      | Secret         | Snapshot Copy starts, discovery, and manifests |
| `TINYBIRD_AGENT_SNAPSHOT_JOBS_TOKEN` | Secret         | Copy job status reads                          |
| `TINYBIRD_HOST`                      | Variable       | Tinybird regional API host                     |
| `BODY_ENCRYPTION_ROOT_KEY`           | Secret         | Delivery encryption                            |
| `SENTRY_DSN`                         | Secret         | Error monitoring                               |

## Failure semantics

- A non-reference message on the ingest queue logs `agent_consumer.message_off_contract`, reports a
  Sentry error, and retries until it dead-letters. The consumer does not acknowledge it.
- Invalid delivery references and dispatch failures retry.
- Pricing misses leave `cost_usd` null when usage or pricing coverage is insufficient.
- Ambiguous Tinybird outcomes require receipt reconciliation before another insert.
- Expired uncertain deliveries leave affected dates incomplete, preventing partial publication.
- DLQ payloads are preserved before acknowledgement. Preservation failures retry; erased-organization
  messages are discarded. Agent dead letters support inspection and explicit retirement, not replay.

## Key files

- `apps/agent-consumer/src/index.ts`: Queue handler and service entrypoints
- `apps/agent-consumer/src/delivery-queue.ts`: Delivery dispatch and queue contract guard
- `apps/agent-consumer/src/agent-delivery.ts`: Delivery receipts and retry coordination
- `apps/agent-consumer/src/agent-delivery-coordinator.ts`: Organization write and snapshot coordination
- `apps/agent-consumer/src/delivery-rows.ts`: Immutable priced row plans
- `apps/agent-consumer/src/pricing.ts`: Model-cost lookup and calculation
- `apps/agent-consumer/src/rows.ts`: Tinybird row mapping
- `apps/agent-consumer/src/dead-letters.ts`: Shared dead-letter preservation and recovery
