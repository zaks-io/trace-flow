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
provides the previous date, revision, and content hash. Receipt materializations permit uncertain
inserts to be reconciled without blindly inserting again.

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

Superseded snapshot generations are deleted by the existing privileged Convex backend after a grace
period. Consumer Workers receive scoped append, Copy, and read permissions. Tinybird datasource
creation/deletion authority remains outside the data-plane Workers. Facts and snapshots retain their
one-year TTL; transport receipts have four-day retention. Day-grain snapshot and identity metadata
expires one calendar year plus one day after its bucket timestamp. The boundary day prevents metadata
from disappearing at midnight while canonical facts from later that date still survive. It does not
extend canonical fact retention.

## Migration and erasure

CI first expands the Tinybird schema while preserving the exact previously deployed endpoints. It
deploys the compatible consumer, pauses producer acceptance, drains and freezes the old batchers,
and copies retained baseline facts at revision 1. New deliveries start at revision 2. A durable
baseline Copy checkpoint prevents a restart from launching another job after an unknown outcome.

Migration verifies all original fact columns in both directions, natural-identity uniqueness,
identity-index parity, and grouped values in all nine published snapshots. The endpoint switch and
producer reopening follow successful verification. A failed migration keeps acceptance paused and
retains the old data. Read-only frozen-ledger export and priced recovery do not allocate another
history-sized confirmation ledger in the full Durable Object.

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

References: [Cloudflare Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/),
[Tinybird deduplication](https://www.tinybird.co/docs/forward/guides/deduplication-strategies),
[Tinybird Copy Pipes](https://www.tinybird.co/docs/forward/core-concepts/copy-pipes),
[Tinybird limits](https://www.tinybird.co/docs/forward/pricing/limits), and
[Tinybird lambda architecture](https://www.tinybird.co/docs/forward/guides/lambda-architecture).
