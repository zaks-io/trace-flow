# Trace delivery and recovery

## Acceptance boundary

The proxy stores a complete delivery envelope in R2 under `trace-deliveries/` before
acknowledging successful capture. The envelope holds the trace metadata and, when body
storage is enabled, the already encrypted Body Object. Queue messages contain a small
reference to that envelope. OTLP exports therefore do not have to fit inside a queue
message. OTLP returns a retryable 503 when durable intake fails, including temporary
usage-check failures.

The proxy's scheduled sweep republishes pending references. Queue failure after the
R2 write cannot discard the envelope. Each environment sweeps its own prefix, including
dev and preview when they share a bucket. The consumer copies the encrypted Body Object
to its canonical `bodies/{requestId}` key, stages metadata in its Durable Object, and
only then removes the envelope. Repeated references are safe after that handoff.
Bodies stay encrypted while awaiting recovery; `omitBody` deliveries contain no Body
Object. The consumer does not need the body decryption key.

Interrupted proxy streams produce failure transactions with whatever was captured.
Successful response completion waits for durable intake. If storage never accepts a
write, the proxy cannot promise recovery: the response fails instead of claiming a
successful capture. Client disconnection, process termination before durable intake,
and capture size limits remain real boundaries. This is not an unconditional promise
that every byte sent to the proxy survives every failure.

R2 body expiration applies only to `bodies/`. Pending deliveries must not have an
expiration rule. Deployment runs `scripts/setup-r2-lifecycle.ts` for the exact target
bucket before enabling delivery references and deploys the consumer before the proxy.
The script narrows the old managed whole-bucket expiration rule when present, preserves
unrelated lifecycle rules, and refuses a conflicting expiration rule that would remove
pending deliveries. It does not introduce a new expiration policy where none existed.

Do not roll the consumer back to a version that cannot read delivery references while
the queue or outbox still contains them. A proxy rollback can stop producing new
references, but the compatible consumer must finish existing deliveries.

## Proxy recovery sweep limits

The five-minute cron invokes one `TraceDeliverySweep` Durable Object per producer
namespace. An in-flight guard skips overlapping calls. Each run scans at most ten
pages of up to 1,000 envelopes. It checks a 30-second elapsed-time budget between
pages; the current page and its bounded listing retries finish before stopping.
Recovery references use Queue `sendBatch` in groups of up to 100 messages, keeping
publication at most 100 batch calls per run. See the
[Queues batch limits](https://developers.cloudflare.com/queues/configuration/javascript-apis/#queue).

After every fully published page, the coordinator durably saves the last scanned
key. Subsequent runs use R2 `startAfter`, so progress survives a restart and consumer
deletion of that key. A complete pass clears the position and the next cron starts
from the beginning. Keys inserted before the saved position, and envelopes that
were too young when scanned, are considered on the next pass. Large backlogs
therefore increase recovery latency; `passAgeMs` exposes that delay. The retained
envelopes remain the source of truth, with no recovery expiration.

A failed queue batch stops the sweep without advancing that page's position. The
next cron retries the page; successful earlier batches may be published again.
Consumers already deduplicate those references. No sweep deletes an envelope or
changes the consumer acknowledgement boundary.

`proxy.delivery_sweep_completed` and `proxy.delivery_sweep_failed` report the producer
`environment`, `pages`, `listAttempts`, `throttles`, `scanned`, `enqueued`,
`queueBatchAttempts`, `enqueueFailures`, `latencyMs`, `passAgeMs`, `resumed`, `hasMore`,
and `stopReason`. `enqueueFailures` counts rejected batch calls; an uncertain failed
publication is not counted as confirmed `enqueued`. A bounded run has
`stopReason=page_limit` or `time_budget` and `hasMore=true`; it is a successful partial
scan. `proxy.delivery_sweep_skipped` records `reason=already_running`.

For a recurring R2 throttle, compare `listAttempts` and `throttles` against `pages`
in the same environment. Rising `passAgeMs`, repeated partial scans, queue failures,
or overlap skips need investigation even when ordinary request processing succeeds.
The baseline empty scan remains one R2 listing every five minutes. This change
bounds outage recovery work; it does not establish why R2 throttled a low-volume
listing or replace the outbox with a delivery index.

## Tinybird delivery

Both consumers use `wait=true` and require HTTP 200 with a receipt confirming every
row and zero quarantined rows. HTTP 202 is not a database acknowledgement. See the
[Tinybird Events API](https://www.tinybird.co/docs/api-reference/events-api).

Before attempting an insert, the proxy batcher persists an in-flight recovery record.
Only 429 and 503 are automatically retryable, because Tinybird documents those responses
as having inserted no rows. Timeouts, malformed receipts, partial ingestion, and other
ambiguous outcomes remain in durable proxy recovery storage. They are not blindly resent
to a non-idempotent endpoint.

A consumer deploy resets busy Durable Objects. A proxy insert in flight at that moment
is retained as `uncertain` with `reason=worker_restarted_with_in_flight_insert`, whether
or not Tinybird committed it. Cloudflare can also retire an instance mid-request, so the
stored reason may hide the real response, such as a 520. Reconcile these records like
any other uncertain proxy insert.

Proxy recovery records retain rejected and uncertain payloads and outcomes without
blocking later healthy work. Changed content under an existing proxy span identity is
retained as a repair record because an ordinary append would corrupt aggregate counts.
Agent deliveries write versioned canonical facts and reconcile uncertain writes
through delivery receipts. Agent snapshots publish only after all captured dates succeed.
Both pipelines preserve DLQ messages instead of relying on finite queue retention.
Proxy dead letters support replay; agent dead letters support explicit retirement only.

If DLQ preservation itself fails, the message remains unacknowledged. Agent delivery
preservation reports the original exception at fatal level with `operation=dlq_preserve`.
Its first retry waits 60 seconds, then delays double up to four hours. This
[attempt-based backoff](https://developers.cloudflare.com/queues/configuration/batching-retries/#apply-a-backoff-algorithm)
recovers brief failures quickly while retaining a long retry window during outages.
Proxy delivery preservation emits a fatal `dead_letter_preservation_failed` event
and uses the configured four-hour retry delay. Both DLQ consumers allow 100 retries.
Until preservation succeeds, proxy and agent DLQ messages remain subject to
[Cloudflare queue retention](https://developers.cloudflare.com/queues/platform/limits/).
An outage lasting through that retention window can still lose those messages;
new proxy deliveries retain their R2 envelope independently. Treat preservation
failures as incidents, not ordinary Tinybird backlog.

## Operator access

Consumers expose `TraceRecovery` as a private Workers service entrypoint, not a public
HTTP endpoint. The local operator tool connects to it through authenticated Wrangler
[remote service bindings](https://developers.cloudflare.com/workers/local-development/).
It needs Cloudflare access to the target account. No new application secret is needed.

Start the tool against dev:

```sh
bunx wrangler dev --config scripts/ingest-recovery/wrangler.jsonc --ip 127.0.0.1 --port 8799
```

Use `--env production` only with production approval. `--env preview` connects to the
proxy preview consumer; the agent pipeline has no separate preview consumer. This
tool is for local use and must not be deployed. Its HTTP handler rejects browser
origins and non-local hosts.

Create a local JSON request file:

```json
{
  "pipeline": "proxy",
  "shardId": "0",
  "options": { "limit": 20, "state": "blocked" }
}
```

Proxy shard IDs are decimal shard numbers. For `"pipeline": "agent"`, use the
Organization ID for delivery and snapshot inspection. Agent DLQ records are retained
in the shared `org:__dlq__` object; use `"shardId": "__dlq__"` to list them. Resolve
an agent dead letter with `retire-dead-letter` after investigating its payload. Agent
dead letters cannot be replayed through this service.
Fetch records into a protected local file, not logs or chat:

```sh
umask 077
curl --fail-with-body -H 'Content-Type: application/json' \
  --data-binary @recovery-request.json \
  http://127.0.0.1:8799/listRecovery > recovery-records.json
```

Follow `nextAfterId` using `options.afterId` until it is null. Payloads are complete
and can contain private analytics metadata. Keep the files private.
Pages return every recovery kind; filter on each record's `kind` locally. Count, byte,
state, and cursor bounds apply to every page.

## Reconciliation

For proxy insert recovery, use the Tinybird console to verify the exact target
datasource and every identity in the recovery payload. A missing HTTP response is not
proof of a missing write.
Proxy recovery rows use the internal flat `Events.*` and `Links.*` fields; the insert
transport nests those fields for Tinybird. Their analytics identifiers match the
submitted rows, including when replaying legacy credentials.

- If every row is already present with the expected content, use `confirm-written`.
- If no row was written, fix the rejection first, then use `confirm-not-written` to
  release the original rows for delivery.
- If some rows were written, repair only the missing rows and affected materializations
  before confirming the whole payload written. Do not replay the full batch.
- For a changed-content repair, `retain-original` explicitly accepts the stored version.
  If the correction should replace it, rebuild the affected analytical data from the
  retained payload first. An append cannot safely replace previously aggregated facts.
- For a DLQ record that must not be replayed, use `retire-dead-letter`. The record
  stays as a resolved audit entry with its payload; nothing is written to Tinybird.
  Prefer it when replay would write rows that are no longer valid, such as messages
  older than the retention columns, which would default `RetentionExpiresAt` to 0 and
  feed materialized rollups while the rows expire immediately.

Example reconciliation request:

```json
{
  "pipeline": "proxy",
  "shardId": "0",
  "confirm": "apply-recovery",
  "options": {
    "recoveryId": 12,
    "action": "confirm-not-written",
    "reason": "Verified all payload identities absent after repairing the schema"
  }
}
```

POST it to `/reconcileRecovery`. The reason and resolution are retained for audit.
For the proxy pipeline only, replay a DLQ record by posting the same shape without
`action` to `/replayDlq` after fixing the underlying failure. A failed replay remains
blocked. Do not repeatedly replay unchanged malformed messages. The agent pipeline
offers `listRecovery`, `reconcileRecovery`, `inspectDeliveryStatus`, and `resumeSnapshot`;
it rejects `/replayDlq`. All mutations require `"confirm": "apply-recovery"`.

Inspect blocked recovery counts even when the normal queue is draining. A healthy
queue depth does not mean all historical deliveries were committed. Never delete
pending outbox or recovery records as cleanup.

## Collector replay

Claude and Codex parser upgrades reparse previously known local transcripts, including
Codex `archived_sessions`. New history still follows the selected import window. An
explicit `trace-flow sync --since 1y --replay` resends Claude, Codex, and Cursor facts
while preserving the local cursor evidence. Cursor snapshots include committed SQLite
WAL records and retained messages without session headers. Content hashes detect edits
even when message counts and creation timestamps stay unchanged; existing cursors
without a hash trigger one reparse. Set the collector endpoints to dev for
verification. Running that command against a saved production connection requires
production approval. It does not prove that an asynchronously accepted fact reached
Tinybird; compare persisted identities afterward.
