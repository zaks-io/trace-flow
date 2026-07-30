# Project Claim as the Attribution Trust Anchor

Trace Flow attributes agent **Authoring Cost** to a place in the code world so it can be reported and correlated with delivery. This document explains why we anchor that attribution to a user-declared **Project** via an explicit, reversible **Project Claim** rather than trying to make the automatic **Repo** identity trustworthy on its own.

## The Problem

Agent facts are stamped at ingest with a `repo_fingerprint`: `hash(normalized git remote)` when the Collector's sync layer resolved a remote for the session, otherwise `hash(path)` stamped `repo_source = 'path'` (a **Provisional Repo**). We need attribution stable enough to report cost per code unit and to correlate cost against delivery signals.

The dev data (1,246 sessions, verified 2026-06) shows the automatic identity is not stable enough:

- **Remote-backed identity collapses cleanly**: 657 sessions over just 17 distinct fingerprints.
- **Path-fallback identity fragments badly**: 589 sessions over 151 distinct fingerprints — roughly one identity per four sessions.
- **The same logical repo fragments**: identical branch names appear under multiple fingerprints (many `t3code/*` branches under two each; `main` under 27). A worktree, a renamed checkout, and an off-root `cwd` of the _same_ repository each hash to a _different_ Provisional Repo and never merge.

CONTEXT.md described Provisional Repos as able to "heal into a remote-backed Repo" — but no such promotion code exists. Healing was documented and never built. So ~half of sessions sit on permanently fragmented identities, and any per-Repo or per-Pull-Request cost built on them inherits that fragmentation.

This compounds with the workflow problem (see the orchestrated-loop attribution analysis): per-Pull-Request allocation is already untrustworthy because an orchestrator smears spend across many sessions and `cursor` cost is vendor-hidden. Building correlation on a fragmented identity key would render confidently wrong numbers faster.

## Alternatives Considered

### Build the fingerprint healing the docs described

Retroactively resolve a remote for path-fallback sessions and merge their fingerprints into the remote-backed one.

- **Racy and cross-session**: healing needs to revisit prior sessions when a later observation of the same path resolves a remote — stateful, ordering-dependent, and easy to get subtly wrong.
- **Can never reach 100%**: local-only, pre-push, and detached work _legitimately_ have no remote (this is expected, not an error). The residue still fragments.
- **Heuristic merges risk silent wrong merges** — exactly the suspect-number failure mode we refuse to ship.

It reduces fragmentation but cannot be the thing correlation depends on.

### Auto-group by fuzzy signals (path stem, repo name)

Cheap, but merges things that only look alike, producing wrong totals with no human in the loop. Rejected for the same suspect-number reason.

### Anchor attribution to a user-declared Project (chosen)

Default everything to **Unattributed**. Auto-attribute _only_ on unambiguous remote identity. Let a human assert a **Project Claim** — "this Repo is part of this Project" — and roll fragmented Repos up to the stable, user-owned Project.

## Decision

The **Project** is the stable trust anchor above the messy Repo identity layer. Untrustworthy or fragmented Repo data associates to a Project by an explicit **Project Claim**, not by trusting the fingerprint.

- **Unattributed by default.** No guessing. Auto-attribution happens only for unambiguous git-remote identity.
- **Claims are rare, explicit, reversible.** A user claims a Repo into a Project; a Repo can be unassociated or moved. A Repo is atomic — claimed whole, never split across Projects.
- **Reversibility is bounded by fact retention.** A claim re-aggregates only the affected `(Project, day)` buckets over _retained facts_ (within the **EventAt** horizon, ~1 year). Re-attribution needs only the extracted facts, not a **Conversation Archive**, so unenrolled Organizations retain the same claim window. Days whose facts have aged out are immutable.
- **Recompute is scoped, not global.** A claim/move touches one or two Projects' affected days and re-materializes only those.

## Data Layering

The mapping and the result live in different places, and Convex computes neither:

- **Tinybird** is source of truth: raw agent facts with their honest, fragmented fingerprints.
- A **data processing layer** applies the **Project Claim** mapping, rolls Repos up to Projects, and joins **Repo Daily Authoring Cost** against **Delivery Signals** on a `(Project, day)` axis.
- **Convex** (control plane) holds two things and computes neither: the **Project Claim** mapping (user-owned input, the trust anchor) and the materialized **Spend–Delivery Correlation** projection (read-only output rendered in near-real-time).

This is why extract-then-eject matters beyond storage cost: keeping distilled facts while ejecting raw bodies is precisely what keeps the user-declared mapping editable for the full fact-retention window.

## Trade-offs

- **Manual step**: a Project is only as good as the Claims a user makes. Accepted — a human assertion beats a wrong heuristic, and Claims are infrequent (a handful, then near-zero).
- **Unattributed remainder is visible, not hidden**: cost on unclaimed Provisional Repos renders on its own until claimed. This is honest, and matches the existing stance that unattributed cost is expected, not an ingestion error.
- **No sub-Repo splitting**: a Repo that genuinely mixes two projects stays unattributed rather than being split. Splitting reintroduces the per-unit allocation mess we rejected.
