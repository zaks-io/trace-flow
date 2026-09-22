# Remove the Conversation Archive

Status: Accepted

Date: 2026-09-22

Related issue: [TRA-295](https://linear.app/zaks-io/issue/TRA-295)

## Context

The Conversation Archive shipped across PRs #433 through #550, but it never completed a verified
production release. The team spent a week and a half repairing repeated failures without getting a
reliable service. On 2026-09-21, a 90-day Collector Credential expiry was mapped to the archive's
`Frozen` policy and caused a production outage.

Raw source transcripts remain in the agent stores on their owners' machines. The analytics Collector
parses those files locally and uploads redacted typed facts. The Archive service did not become a
reliable prerequisite for that analytics path.

## Decision

Remove the Conversation Archive feature. This removes the Archive API Worker, both Rust archive
crates, archive-specific embedder and desktop code, nine Convex tables, six HTTP routes, the Web
settings surface, and archive export and smoke scripts. Keep the analytics Collector and
`collectorCredentials` for fact sync.

Delete the production archive R2 bucket without exporting its contents. The source transcripts remain
on their owners' machines.

## Consequences

Trace Flow no longer stores or exports raw source transcripts. Agent Conversation Analytics continues
to store derived typed facts. Users can recover source transcripts from their local agent stores.

The archive portions of [ADR 0012](./0012-agent-conversation-analytics.md),
[ADR 0013](./0013-r2-storage-caps.md), [ADR 0014](./0014-storage-quotas.md),
[ADR 0015](./0015-trace-flow-desktop-collector.md), and
[ADR 0020](./0020-read-side-secret-boundaries.md) are superseded. Their unrelated analytics,
collector, desktop, Body Object, and read-side decisions remain in force.
