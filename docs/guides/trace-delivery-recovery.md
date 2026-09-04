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

## Tinybird delivery

Both consumers use `wait=true` and require HTTP 200 with a receipt confirming every
row and zero quarantined rows. HTTP 202 is not a database acknowledgement. See the
[Tinybird Events API](https://www.tinybird.co/docs/api-reference/events-api).

Before attempting an insert, the batcher persists an in-flight record. If the process
stops during the request, the next run treats its outcome as uncertain. Only 429 and
503 are automatically retryable, because Tinybird documents those responses as having
inserted no rows. Timeouts, malformed receipts, partial ingestion, and other ambiguous
outcomes remain in durable recovery storage. They are not blindly resent to a
non-idempotent endpoint.

Rejected and uncertain batches do not block later healthy work. Recovery records
retain complete payloads and outcomes. Changed content under an existing span or fact
identity is retained as a repair record; replaying it as an ordinary append would
corrupt aggregate counts, so it requires reconciliation. DLQ messages are likewise
preserved for explicit replay instead of relying on finite queue retention.
Message deduplication records remain durable for that same unbounded recovery lifetime.

If DLQ preservation itself fails, the message is retried and a fatal
`dead_letter_preservation_failed` event is emitted. DLQ consumers use 100 retries
spaced four hours apart to avoid exhausting retries during a brief storage outage.
Until preservation succeeds, legacy and agent DLQ messages remain subject to
[Cloudflare queue retention](https://developers.cloudflare.com/queues/platform/limits/).
An outage lasting through that retention window can still lose those messages;
new proxy deliveries retain their R2 envelope independently. Treat preservation
failures as incidents, not ordinary Tinybird backlog.

## Operator access

Consumers expose `TraceRecovery` as a private Workers service entrypoint, not a public
HTTP endpoint. The local operator tool connects to it through authenticated Wrangler
[remote service bindings](https://developers.cloudflare.com/workers/local-development/).
It needs Cloudflare access to the target account. No new application secret is needed.

Start the tool against Cloud-Dev:

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

Proxy shard IDs are decimal shard numbers. For `"pipeline": "agent"`, `shardId` is
the Organization ID; malformed agent DLQ messages are retained under `"__dlq__"`.
Fetch records into a protected local file, not logs or chat:

```sh
umask 077
curl --fail-with-body -H 'Content-Type: application/json' \
  --data-binary @recovery-request.json \
  http://127.0.0.1:8799/listRecovery > recovery-records.json
```

Follow `nextAfterId` using `options.afterId` until it is null. Payloads are complete
and can contain private analytics metadata. Keep the files private.

## Reconciliation

Use the Tinybird console to verify the exact target datasource and every identity in
the recovery payload. A missing HTTP response is not proof of a missing write.
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
For a DLQ record, POST the same shape without `action` to `/replayDlq` after fixing
the underlying failure. A failed replay remains blocked. Do not repeatedly replay
unchanged malformed messages.

Inspect blocked recovery counts even when the normal queue is draining. A healthy
queue depth does not mean all historical deliveries were committed. Never delete
pending outbox or recovery records as cleanup.
