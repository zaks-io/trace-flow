# Bounded agent ingestion and replaceable analytics

Status: Accepted

This supersedes the permanent fact-ledger and additive-rollup ingestion decisions in
[ADR 0012](./0012-agent-conversation-analytics.md). Coding-agent analytics retains one calendar year
of typed facts, matching the existing Tinybird `toIntervalYear(1)` TTL.

## Problem

The per-organization Durable Object retained complete serialized fact payloads, pending copies, and
repair payloads indefinitely. One organization reached Cloudflare's 10 GB SQLite limit. A ledger that
grows with conversation history cannot be the ingest coordinator. Additive materialized views also
make uncertain retries and same-identity corrections expensive to repair.

## Decision

The Collector parses and redacts locally. Agent Ingest validates the entire request and rejects
conflicting content for one natural fact identity before claiming sessions or storing data. Exact
within-request duplicates collapse. Raw transcripts use the separate consented Archive contract.

Agent Ingest stores bounded encrypted delivery objects in R2 before acknowledging acceptance. Queue
messages carry tenant-bound references. A delivery Durable Object stores receipt metadata, and an
organization coordinator assigns monotonically increasing revisions and serializes canonical writes.
The coordinator stores at most 64 active delivery references and one calendar year of dirty-day
metadata. The date-bucket cap includes leap years and both boundary dates. Neither object retains
historical fact bodies.

Pricing runs once per delivery. The encrypted priced plan is immutable across retries. Delivery
buffers are removed after confirmed ingestion and expire after four days if delivery cannot finish.
An expired uncertain delivery leaves affected days incomplete, preventing publication of silently
partial aggregates. Recovery must verify and restore those facts from preserved sources before
clearing the incomplete days. A successful ingress response confirms durable acceptance, not a
completed Tinybird insert.

Six versioned `ReplacingMergeTree` fact tables replace same-identity versions using the accepted
revision. Natural replacement keys include the event date. Moving an identity between dates writes
an old-date tombstone and a new-date live row under the same revision. A bounded identity lookup
provides the previous date, revision, content hash, and source ingest time. Queue and DLQ messages
accepted before migration keep that source ordering: older facts cannot replace newer canonical
facts, and ambiguous equal-time conflicts fail for operator review. Receipt materializations permit
uncertain inserts to be reconciled without blindly inserting again.

Nine snapshot targets are rebuilt from canonical facts with scoped `FINAL` reads. Snapshot jobs
filter the organization and captured dates before aggregation and use `max_threads = 1`. Canonical
facts and snapshots use monthly physical partitions to avoid the Copy partition limit across a full
year. Ordinary generations capture at most seven dirty dates. Linked correction dates are captured
together; oversized sets run bounded date chunks under one unpublished generation.

A single immutable manifest row publishes all captured dates after every target and chunk succeeds.
Readers select the highest published generation per date. A delayed older job cannot revert a newer
publication. Copy start intents are durable before the HTTP request, and unknown outcomes remain
unresolved until a matching terminal job is found. Copy job history is not assumed to prove that an
unknown request never ran.

Snapshot scheduling targets roughly five-minute dashboard freshness for ordinary batches. The
coordinator batches dirty dates for one minute, then uses one durable alarm to dispatch each
continuation. A Copy's first status check is after five seconds, followed by a ten-second delay
to retain the previous 15-second observation for jobs that are still running. Later checks use
30-second and then 60-second delays. This adds at most one status read before the old first check;
persisted due times remain unchanged across rollout. Checks use Tinybird's Jobs API
(`GET /v0/jobs/:id`), not a SQL endpoint over
`jobs_log`. The next check time and attempt count are persisted before the request, so duplicate
queue deliveries cannot restart the polling cadence. There is no immediate continuation enqueue.

The local workerd timing experiment uses real coordinator SQLite state and simulated provider
completion. With two-second Copies, one-day and seven-day generations reduce polling wait from
135 to 45 seconds with nine status reads; 32 linked dates reduce it from 270 to 90 seconds with
18 reads. With seven-second Copies, the wait remains 135 seconds and reads increase from nine
to 18. The early probe counts toward the unchanged 15-check budget. This measures scheduling
wait only; actual Copy execution, alarm dispatch, queue delivery, and RPC latency still need
verification against an isolated Tinybird branch before claiming a production gate-duration target.

A global Durable Object admits two snapshot generations at a time. If no slot is available before
any Copy starts, the coordinator ends that attempt, preserves dirty dates, and reopens ingestion
while waiting. Each admitted generation starts one Copy at a time and retains its slot until its
durable intents are settled and the generation ends.
Capacity never expires on a timer: an unknown Copy may still be running. The organization delivery
gate stays closed throughout a generation because separate `FINAL` reads must see stable input.
Removing that gate requires an immutable input boundary and is not part of this change.

Each Copy permits 15 Jobs API checks. A missing start receipt or expired Jobs API record permits
three bounded `jobs_log` discovery queries; normal successful execution makes none. Exhausting
either budget stops scheduling, emits an error, and retains the gate and capacity reservation for
operator recovery. The private recovery service exposes inspection and an explicit, reasoned resume
of the same generation. Large linked corrections and provider delays can exceed five minutes;
`agent_snapshot.published` records dirty age and gate duration rather than promising a hard deadline.
For a verified non-submission, explicit operator recovery may retire an exhausted jobless intent
and its unpublished generation, retain dirty days, and resume them in a new generation. The exact
intent and expired claim must match; an empty job history alone never authorizes this action.

Superseded snapshot generations are deleted by the existing privileged Convex backend after a grace
period. Consumer Workers receive scoped append, Copy, and read permissions. Tinybird datasource
deletion authority remains outside the data-plane Workers. The snapshot runner has a separate
`TINYBIRD_AGENT_SNAPSHOT_JOBS_TOKEN` with `DATASOURCES:CREATE`: dev Copy job reads returned 403
with target-scoped `APPEND` despite the Jobs API documentation. Isaac approved this permission on
2026-09-22. Tinybird rejects operational scopes on deployment-managed resource tokens, so the CI
token provisioning script creates and verifies this separate operational token. The runner uses it
only for job-detail GETs; Copy starts, discovery and manifest writes retain their resource token.
Facts and snapshots retain their
one-year TTL; transport receipts have four-day retention. Day-grain snapshot and identity metadata
expires one calendar year plus one day after its bucket timestamp. The boundary day prevents metadata
from disappearing at midnight while canonical facts from later that date still survive. It does not
extend canonical fact retention.

## Migration and erasure

Retirement note, 2026-10-08: TRA-391 retired the migration, baseline Copy, and frozen-ledger
tooling after the ingestion migration completed. The design and verification record below
describes the completed cutover. Isaac wrote off the retained legacy records on 2026-10-08
instead of replaying or retiring them (TRA-298). When TRA-391 deploys, a Wrangler
`deleted_classes` migration permanently deletes the AgentFactBatcher class and all its storage,
including preserved recovery records and dead letters. A new AgentDeadLetters class preserves
future dead letters in the shared `__dlq__` instance. TRA-298 completes after deployment by
confirming the storage drop. Cloudflare documents the permanent deletion in its
[legacy class migration reference](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/).

TRA-405 retires the legacy Tinybird datasources, baseline copies, six frozen signal writers and the deployment overlay under Isaac's 2026-10-09 approval. Signal datasources, endpoints and snapshot copies remain. Production now deploys repository resources directly, with destructive operations allowed only when every deletion is listed in `scripts/ci/tinybird-retired-resources.json`. Future retirements require adding names to that manifest in a human-reviewed, human-merged PR. Post-deploy read-only Tinybird inventories prove retained resources present and retired resources absent, alongside Worker binding checks and `Deployment Status`.

The historical migration below describes the completed cutover, not the current deployment procedure.

CI first expands the Tinybird schema while preserving the exact previously deployed endpoints. It
deploys the compatible consumer, pauses producer acceptance, drains and freezes the old batchers,
and copies retained baseline facts at revision 1. New deliveries start at revision 2. A durable
baseline Copy checkpoint prevents a restart from launching another job after an unknown outcome.
Each category's source proof becomes an immutable plan of at most seven calendar days, 50,000
global-winner rows, and 64 MiB of projected tuple JSON per Copy. The checkpoint records one active
intent and ordered job receipts, so a lost response is recovered from one exact `jobs_log` match and
a terminal partial failure cannot submit another chunk.

A terminal failed whole-window checkpoint transitions to this bounded plan only through the local
operator with `--retry-journal` pointing at a private filesystem directory. The journal is fsynced
before the coordinator archives the failed receipt and its evidence hashes. The deployment Action
does not supply this option: it stops at a failed legacy checkpoint until the operator preserves the
provider record and arms the bounded plan, after which an ordinary rerun resumes its chunks.

Legacy MergeTree tables can contain multiple versions of one identity. The baseline selects the
greatest `IngestedAt` per natural identity across the retained window, matching the existing recovery
ordering. Identical retries collapse; conflicting full rows with the same identity and `IngestedAt`
stop migration. The preserved legacy tables are not rewritten. Verification selects the global
winner before filtering each date chunk, so an event-date correction cannot revive the older row.
On resume, winner selection and equal-time conflict checks still use the original Copy window;
current retention filters the selected winners afterward.
Organization discovery scans one datasource and at most 31 dates per query, sequentially, and enforces
the organization limit across the complete result.

Migration verifies all original fact columns in both directions, natural-identity uniqueness,
identity-index parity, and grouped values in all nine published snapshots. The endpoint switch and
producer reopening follow successful verification. A failed migration keeps acceptance paused and
retains the old data. Read-only frozen-ledger export and priced recovery do not allocate another
history-sized confirmation ledger in the full Durable Object.

The proof compares the selected legacy versions to canonical facts first, then canonical facts to
published snapshots. Targeted frozen recovery also requires a completed migration and a matching
Tinybird workspace before it creates a journal or replays data.

Organization deletion fences new deliveries and snapshots, waits for admitted writes and Copy
intents to settle, erases old organization storage and matching legacy dead letters, and removes
existing tenant-scoped delivery objects before deleting Tinybird rows. A staging request already in
flight can leave an encrypted orphan subject to the four-day R2 lifecycle. Deletion does not claim
instant physical removal of such an orphan. Unknown Copy outcomes block successful deletion rather
than allowing a later job to recreate one-year analytics history. A control-plane migration lock
prevents baseline copying from racing organization deletion.

## Verification

Local tests cover ambiguous insertion, receipt matching, correction tombstones, immutable recovery
plans, atomic snapshot publication, bounded metadata, leap-year retention, and erasure races. The
Tinybird proof uses an isolated cloud branch, including two million messages across 366 days.
Execution time and rows/bytes read are measured separately; a passing small fixture does not prove
full-history performance. Production completion requires a successful CI cutover plus comparison
against the Collector's local identity inventory.

A read-only production preflight on 2026-09-14 found that the combined six-table organization scan
timed out after 20 seconds. The sequential 31-day scans completed all 72 queries in 6.16 seconds of
combined database execution, with a maximum of 0.56 seconds per query. `system.query_log` recorded
0.84 seconds of combined user and system CPU time for those 72 queries, reading 2,546,263 rows and
124,766,887 bytes. These measurements cover organization discovery, not the complete migration.

The isolated branch produced these measurements on 2026-09-13:

- A full-year baseline Copy transformed two million wide message rows in 13.275 seconds, reading
  2,008,386 rows and 624,419,062 bytes. The current Developer Copy limit is 30 seconds.
- An ordinary seven-day generation completed all nine serial Copies in 34.221 seconds wall time. Its
  jobs read 475,776 rows and 85,415,812 bytes; the slowest Copy took 2.521 seconds.
- A 366-day linked component completed 108 serial Copies in 743.346 seconds wall time. Jobs read
  23,033,910 rows and 4,136,086,054 bytes; the slowest Copy took 9.743 seconds. All sixteen endpoint
  results matched the prior single-Copy generation exactly after the one-row manifest publication.
- The optimized default context-health query fell from 4.303 seconds and 1,245 MB read to 0.229
  seconds and 11.05 MB. Session-cost distribution fell from 7.861 seconds and 2,099 MB to 2.171
  seconds and 440 MB. An empty review-unit query fell from 1.229 seconds and 312 MB to 0.036 seconds
  and 262 KB.
- The first settled session browser read 1,064 MB for one organization and took 2.71 seconds on the
  adversarial full-retention fixture. A two-stage query over the day-first snapshot key regressed to
  1,424 MB. Moving `session_pk` immediately after `OrgId` in this snapshot alone, then loading wide
  aggregate states for the selected page, reduced the full-year request to 464.5 MB and 1.402
  seconds with exact output parity. Its twelve 31-day Copies each completed within 11.286 seconds.
  Session-cost distribution remained at its prior 439.6 MB scan. These one-user reads still require
  production monitoring before claiming multi-tenant query capacity.
- Manifest lookup remained tenant-pruned: 200 fixture organizations read 8,192 rows and 474,372
  bytes in 3.664 milliseconds, while one organization with 100,000 retained commits read 105,716
  rows and 6,326,000 bytes in 11.650 milliseconds.
- A correction crossing December into January left two physical identity-index rows in separate
  monthly partitions. The branch's `FINAL` read returned exactly one current row at the later
  delivery sequence. Identity lookups also receive the consumer's exact calendar retention bounds
  so asynchronous TTL cleanup cannot expose an expired prior day. A 32-identity lookup against the
  two-million-row fixture read 16,384 index rows and 2,533,522 bytes in 8.307 milliseconds.
- Delivery and frozen-replay identity lookups pair each identity with its category in one POST
  request, splitting only at 512 identities or 64 KiB of identity text; Tinybird rejects queries
  above its maximum size. Production had issued one 200 to 450 millisecond request per 32 identities
  per category ([TRACE-FLOW-2Y](https://zaksio.sentry.io/issues/TRACE-FLOW-2Y)). On a
  three-million-row Tinybird Local index with 13 monthly partitions, one 261-identity, six-category
  lookup read 1,140,219 rows in 23 to 28 milliseconds and peaked at 93 MiB or less. The same identities
  as twelve per-category requests read about 2.7 million rows, each request peaking near 138 MiB.
  The sorting-key filter runs in `PREWHERE`, which is safe under `FINAL` because every version of an
  identity shares those columns; filtering after `FINAL` instead merged every scanned row and used
  567 MiB and 95 milliseconds.
- Frozen-fact verification pages use the event date and native identity tuple. On the two-million-row
  fixture, a 5,000-row message page read 10,960 rows and 4,306,206 bytes in 44.075 milliseconds. The
  remaining 464-row page used the same bounded scan and completed in 24.741 milliseconds.

References: [Cloudflare Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/),
[Tinybird deduplication](https://www.tinybird.co/docs/forward/guides/deduplication-strategies),
[Tinybird Copy Pipes](https://www.tinybird.co/docs/forward/core-concepts/copy-pipes),
[Tinybird limits](https://www.tinybird.co/docs/forward/pricing/limits), and
[Tinybird lambda architecture](https://www.tinybird.co/docs/forward/guides/lambda-architecture).

### Collector retry identity

Collector retries within one POST cycle resend the same payload and `collector_batch_id`.
Ingress records a small conditional request manifest at
`agent-deliveries/{org}/requests/{identity}` before claiming sessions. The identity includes the
authenticated organization, Collector and batch. Its digest covers the original validated
request before retention or redaction changes facts. Conflicting or expired reuse returns
`409 batch_identity_conflict`. The manifest shares the organization's erasure prefix and the
four-day R2 lifecycle. It contains only hashes and expiry metadata, with no fact bodies.

Each transport chunk uses a content digest scoped to that same organization, Collector and
batch. The digest excludes enqueue timestamps and Sentry trace context. Retention or ownership
changes can produce different canonical chunks on a legitimate retry, so chunk content belongs
in the delivery identity. Chunk sizing reserves the maximum serialized trace-header budget and
timestamp width. Headers exceeding that budget fail validation before ownership is claimed.

SHA-256 supplies 122 identity bits in the currently accepted v4 UUID key shape. This preserves
the deployed key validator during rolling upgrades; these identifiers are deterministic rather
than random UUIDs. Legacy callers without retry identity keep their existing random key path.
Deploy the consumer's receipt RPC before the ingest change. An older consumer missing that RPC
causes fail-closed HTTP 503 responses rather than unsafe acceptance.

Conditional R2 collisions decrypt and validate the existing object, then reuse its original
hash, creation time, expiry and encryption metadata. They never overwrite ciphertext or renew
retention. A read-only receipt lookup checks tenant, expiry and organization erasure before
staging. A second lookup closes the race where completion deletes a body after the first lookup.
When an original receipt exists and the staged immutable reference differs, ingress discards the
recreated body and registers the original reference. Identical concurrent staged references do
not trigger deletion. Registration failures remain failures rather than being reclassified as
identity conflicts. Receipt reuse also remains erasure fenced at registration.

New chunks require two receipt RPC reads in addition to registration. An already registered
retry requires one receipt read. These bounded reads run within the existing ten-delivery
window. They add a latency cost to first uploads in exchange for avoiding duplicate transport
work and ciphertext resurrection. This change preserves the snapshot write fence and the
64-reference admission bound. Cross-cycle retries with a newly minted batch ID remain separate
deliveries, and canonical fact replacement continues to reconcile them.

Identity-day lookups keep the existing 32-identity GET limit, tenant and retention filters,
correction tombstones and legacy ordering. All categories share one six-connection budget,
and lookups finish before any rows change. A deterministic fixture with six categories of
33 identities and 100 ms per request completes in two waves, 200 ms, versus six serial
category waves, 600 ms, with peak concurrency six. This is synthetic scheduling evidence,
not a measured production latency improvement.
