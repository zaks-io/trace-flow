# Provider Usage Tracking

Status: proposed

Captured: 2026-05-25

Provider Usage Tracking is a separate feature from [Agent Conversation Analytics](./0012-agent-conversation-analytics.md) and the [Trace Flow Desktop Collector](./0015-trace-flow-desktop-collector.md). It observes a user's own provider subscription, quota, credit, and rate-limit state over time. Its goal is personal cost visibility: how much am I spending across providers, and at what usage level does pay-as-you-go beat a flat subscription so I should come off the plan. This is the `codexbar` idea, split out of the agent-analytics work because it observes provider account state, not agent transcripts. Bundling it dragged a whole route, queue variant, storage shape, and redaction path into a pipeline that does not need it.

This ADR records the idea and a design sketch so the decision is not lost. It is not a committed v1 build and is not a dependency of the Collector. The Collector ships without it.

## Why Separate

Conversation analytics answers "what did agents do and what did it cost to attribute." Provider usage answers "what does my provider say I have spent and have left." The inputs differ (transcripts vs. a provider account/quota probe), the attribution differs (Repo/Project/Session/PR vs. user-private, no project attribution), and the cadence differs (transcript-driven vs. a periodic poll). Keeping them separate means the Collector's privacy surface, ingest contract, and storage stay focused on transcripts, and provider usage can move at its own pace or live somewhere else entirely.

## Sketch

If built, Provider Usage Tracking could be hosted by the same Trace Flow Desktop app as an independent, opt-in capability, reusing the ingest Worker, org rate limiting, and queue infrastructure, but with its own route, queue message variant, and storage shape. To preserve least privilege between the two ingest paths, provider-usage writes authenticate with a distinct ingest scope (a separate Collector Credential capability, or a separate credential), not the transcript-ingest capability; the exact scope mechanics are an implementation detail. None of that is wired into the Collector's first-run setup, watcher, sync loop, SQLite state, or diagnostics.

- **Source.** `codexbar` is an optional external dependency. Where present, the app can run `codexbar usage --json --provider all` to collect provider subscription, quota, credit, and rate-limit snapshots. If it is missing, the feature shows as unavailable without an error. A probe that hangs, times out, or errors must not block the app: it is bounded by a timeout, surfaces as stale or unavailable, and falls back to the last known snapshot. Concrete timeout, retry, and staleness thresholds are an implementation detail.
- **Cadence.** When enabled, it runs once after start, every 5 minutes while active, and on manual refresh. It does not run while paused.
- **Scope.** Snapshots are user-private inside the Organization and are never mixed into Repo, Project, Agent Session, or Pull Request attribution.

## Privacy

Provider account identity is privacy-first. Grouping uses a stable hash of provider plus normalized account identifier, and any human-readable label is redacted before upload or storage. Emails become hints like `i***@zaks.io`, not full addresses. Raw provider emails, cookies, tokens, and other known sensitive strings are never stored.

## Purpose

The point is a personal spend timeline, not org analytics. Snapshots track subscription and quota history over time and let the user compare provider-reported usage movement against Trace Flow's observed Agent Message token and output volume by time window. That comparison supports rough investigation into effective usage rates and possible time-varying surcharges, and most importantly informs the subscription-versus-pay-as-you-go decision: at the current usage trend, is the flat plan still cheaper than metered billing.

## Open Questions

- Whether this lives in Trace Flow Desktop, a separate small tool, or stays a manual `codexbar` workflow that never ingests.
- `codexbar` availability and maintenance, and what the feature does when its output format drifts.
- Whether provider-reported numbers are reliable and granular enough to support the pay-as-you-go crossover call, or only a coarse trend.

## Consequences

Splitting this out keeps the Collector's transcript pipeline narrow and its privacy story simple, at the cost of a second (smaller) ingest path and storage shape if and when this is built. Until it is built, the user has no in-product spend timeline and answers the subscription question by hand. That is an acceptable trade for v1.
