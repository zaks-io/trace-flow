# Changelog

Append-only progress log. **Newest entry on top** so parallel PRs merge without conflicts. One entry
per working session or task hand-off. Copy the template.

## Template

```text
## YYYY-MM-DD — <task IDs> — <branch or agent>
**Status:** ✅ done | 🚧 in progress | ⛔ blocked
**Changed:** what landed (files, behavior)
**Verified:** command(s) run + result
**Next / blockers:** handoff for the next agent
```

---

## 2026-05-25 — 0c (@trace-flow/pricing package) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Extracted the per-message server-side cost chain out of
`apps/proxy-consumer/src/pricing.ts` into a new shared `@trace-flow/pricing` package
(`getPricing` / `calculateCost` / `microdollarsToDollars` / `formatCostAsString`, plus the
`ModelPricing` / `ContextTierPricing` / `CostBreakdown` types). Added **`gpt-5.5` context-tier
awareness**: `ModelPricing.contextTier` carries a `thresholdTokens` + tier rates, and `calculateCost`
swaps to the tier rates once a message's input context reaches the threshold (gpt-5.5 prices ~2x above
a 200k-token context and Codex runs near a 258k window, so a flat rate undercounts). The package prices
**one message and nothing else** — it does **not** own subagent dedup (that stays in SQL as
`agent_priced_usage.pipe`, task 1c). Canonical extraction, not a barrel: deleted the old
`pricing.ts` + its test, pointed proxy-consumer's three importers (`index.ts`, `spans.ts`,
`openrouter-pricing.ts`) and one test at `@trace-flow/pricing`, added the workspace dep. Moved the full
test suite into the package and added 4 context-tier tests (below-threshold base rate, inclusive
boundary at 200k, 258k Codex-style window, no-tier flat passthrough) plus the explicit unpriced-model →
null path. Matched the repo convention of inheriting `@cloudflare/workers-types` (the `KVNamespace`
global) from the **root** devDependency rather than re-declaring it (keeps knip clean, mirrors
`@trace-flow/utils`).
**Verified:** `bun run --filter @trace-flow/pricing test` 33/33; `bunx turbo run lint type-check test
--filter=@trace-flow/pricing --filter=@trace-flow/proxy-consumer` green (pricing 33, proxy-consumer 112
— the workerd "invalidating Durable Object" lines are info-level hot-reload noise, all 7 files pass);
`bun run knip` clean; `coderabbit review --agent --type uncommitted` → 0 findings.
**Next / blockers:** None. 0c done. **0d** (CF provisioning + deploy-gate) is the last open first-wave
task; its verify needs live `wrangler` access to a dev account (`wrangler queues list` / `kv namespace
list`) — may be a stop point if the CLI is not authed. 1a/2a/3a/3c unblocked by 0a; 2c/2d depend on 0c
(now ✅).

---

## 2026-05-25 — 0b (Rust workspace scaffold) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Added the repo-root virtual `Cargo.toml` (`resolver = "2"`, `members =
["packages/collector-*"]`) so the `collector-contracts` crate from 0a — and the future
`collector-parser`/`-sync`/`-api-client`/`-common` crates plus `apps/desktop/src-tauri` (Phase 5) —
resolve as one workspace. Glob member pattern means later collector crates join with no root edit. A
header comment records the deliberate split: Turborepo does **not** manage Cargo (a dedicated CI job,
6a, runs `cargo` directly). Added `/target/` to the root `.gitignore` and **committed the root
`Cargo.lock`** (reproducible builds for the 6a CI job and the eventual signed desktop binary; the
crate-level `.gitignore` Cargo.lock entry is now dead but harmless since the workspace lock lives at
root).
**Verified:** `cargo metadata --no-deps` resolves the workspace with `collector-contracts` as the
member; `cargo fmt --check` clean; `cargo clippy --workspace --all-targets -- -D warnings` clean;
`cargo test --workspace` green (round_trip 3/3); `coderabbit review --agent --type uncommitted` → 0
findings.
**Next / blockers:** None. 0b done. **0c** (`@trace-flow/pricing`) and **0d** (CF provisioning)
remain open in the first wave. 6a will add the cargo CI job that runs against this workspace.

---

## 2026-05-25 — 0a (wire contract + Rust mirror) — t3code/ab83918d

**Status:** ✅ done
**Changed:** First feature code for slice B. Defined the full TS wire contract in
`packages/types/src/agent-ingest.ts` (exported from `src/index.ts`): `AgentIngestEnvelope`
(`batch{source, collector_batch_id, desktop_version, parser_version, raw_upload_requested}` +
`facts{messages[], tool_events[], file_events[], capability_snapshots[], pull_request_links[]}`), every
`Agent*Fact` shape (session-grain attribution — normalized git remote, branch, head sha,
vendor*started_at — rides on `AgentMessageFact`; tool use+result folded into one `AgentToolEventFact`
with `extracted_subagent*_`), the deferred `RawSessionBundle`slot, and`AgentIngestQueueMessage`(worker→consumer, adds tenancy + assembled`_\_pk`via explicit`extends`-based queue-fact types, no
`Partial<>`). Mirrored it in a new Rust crate `packages/collector-contracts/`(serde`rename_all="snake_case"`, `enums.rs`/`facts.rs`/`envelope.rs`/`sample.rs`/`lib.rs`, a `dump_sample`example,`.gitignore`for`/target`+`Cargo.lock`). Committed two shared fixtures:
`fixtures/agent-envelope.sample.json`(generated from the Rust`sample_envelope()`, the contract
fixture both languages round-trip) and `fixtures/redaction-canary.json`(12 language-neutral cases —
AWS/GitHub/Bearer/OpenAI/Slack keys, dotenv, JWT, RSA key, absolute home paths — each tagged
drop|mask, consumed by 2b and 3a). Added a vitest setup to`@trace-flow/types` (`vitest.config.ts`,
test scripts, `@types/node`+`vitest`devDeps,`tsconfig` `types:["node"]`) with
`src/**tests**/agent-ingest.test.ts`deserializing the shared fixture into the typed envelope.
**Verified:**`cargo test -p collector-contracts`3/3 green (fixture field-equal to`sample_envelope()`,
deserialize+round-trip with no field loss, redaction-canary well-formed); `cargo fmt --check`+`cargo clippy --all-targets -- -D warnings`clean;`bunx turbo run lint type-check test
--filter=@trace-flow/types`all green (4 tests pass);`coderabbit review --agent --type uncommitted`
→ 0 findings. A serde or TS rename on either side now fails its own assertion, so the contract cannot
silently drift.
**Next / blockers:** None. 0a done. First wave continues — **0b** (Rust workspace root Cargo.toml),
**0c** (`@trace-flow/pricing`), **0d** (CF provisioning) remain open with no dependencies; **1a, 2a,
3a, 3c** unblock now that 0a is `✅`.

---

## 2026-05-25 — review hardening II (autonomous-safety rails) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Second eng-review pass over the guide, focused on the rails an autonomous self-merging
driver needs. Docs only, no feature code. **ROADMAP:** added task **1d** (explicit `tb deploy` of the
`agent_*` schema to the dev workspace; Tinybird is not in CI, so without it 2c/2e would POST to
datasources that do not exist) and task **2g** (PR CI for the new TS packages: `ci.yml`'s `changes`
filter and `status.needs` enumerate only the existing packages, so a PR touching
`pricing`/`agent-ingest`/`agent-consumer` runs no typed job and goes false-green; 2g adds their filters,
per-package jobs, and `status` needs, plus `packages/pricing/**` to the existing `proxy-consumer`
filter). Reworked the **2c** insert path from "reuse `insertIntoTinybird`" to a clean split: extract the
generic transport core (NDJSON + POST + `TinybirdInsertError`) into `packages/tinybird-client` as
`insertRows`, leave the OTel reshape in `proxy-consumer` as a thin caller; noted that non-idempotent
requeue is safe here only because `ReplacingMergeTree(IngestedAt)` keyed on `*_pk` collapses dupes under
`FINAL`. Declared **2d depends-on 2a** so the two tasks that both edit Convex `schema.ts` serialize (2a
lands the tables first). Made the **redaction canary corpus shared**: one `fixtures/redaction-canary.json`
authored in 0a, asserted against by both the Rust parser (3a) and the TS server re-redact (2b). Added
two trust-boundary tests: **2a** concurrent first-writer claim (two simultaneous claims for one
`OrgId+session_pk`, exactly one wins via Convex OCC) and **2b** policy cold-miss fail-closed (a cold
cache plus a failed policy fetch returns 503 `policy_unavailable`, never a fail-open 202). Hardened
**2e/2f** deploy completeness (new workers added to `deploy-status.needs`, not just the deploy jobs;
1d schema must be live on dev first; the 1d deploy command recorded in the 2f runbook). Pinned **1c**
`COPY_SCHEDULE` to hourly and added an `agent_sessions` whole-table-rebuild Watch-item (its `replace`
cost scales with total session count, not the recent window). Carried 1d and 2g into the slice-B task
list and "v1 slice complete when". **README:** dependency graph now shows `1d` (after 1a+1b+1c), `2g`
(after 2b+2c), and `2d` after `0c + 2a`; added a scope note that the new workers use `wrangler.jsonc`
(matching `apps/web`), not the `.toml` of the older workers, and that normalizing either way is out of
scope. An **Outside Voice** (independent sonnet review) then surfaced three more autonomous-safety
gaps, all applied: a **shared envelope contract fixture** in 0a (`fixtures/agent-envelope.sample.json`,
loaded by both the Rust round-trip and a TS deserialize test, replacing the single-sided check so a
serde or TS rename cannot silently drift); the **`agent_sessions` rebuild assertion relocated from 2c
to 1c** (2c does not depend on 1c, so it now asserts base-fact inserts only and the rollup check lives
with the pipe that owns it); and a **file_events path-privacy assertion in 3a** (every path
repo-relative, no `/Users/` or `$HOME`, outside-repo maps to `outside_repo`), so a relativization bug
fails at 3a, not only at 3d. Its proposed scope cut (drop `agent_capability_snapshots`) was
**rejected**: the ADR retains that data deliberately for deferred Context Bloat analysis, and
re-ingesting aged-out local transcripts is unreliable. The accepted **ADR was left unedited**.
**Verified:** Docs only, no build run. ROADMAP board carries 1d and 2g with resolvable `depends-on`;
the README dependency graph, Milestones legend, and slice-B task list all match the board; the new
tasks reference real anchors (`ci.yml` paths-filter and `status.needs`;
`apps/proxy-consumer/src/tinybird.ts` transport core; `apps/web/wrangler.jsonc`).
**Next / blockers:** None. Slice B is still the build target; first wave (0a 0b 0c 0d) is open. 1d is
claimable after 1a+1b+1c; 2g after 2b+2c.

---

## 2026-05-25 — review hardening (slice B + 13 edits) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Applied the CEO-review hardening pass to the guide docs — no feature code. **ROADMAP:**
added tasks **0d** (provision CF queue + DLQ + `COLLECTOR_CREDS` KV; both new workers stay out of CI
deploy until 2e lifts the gate) and **2f** (observability + ops runbook); added a "Milestones" legend;
split the Done bar into "v1 slice complete when (slice B)" vs "Feature complete when (full feature)";
rewrote 0c so `@trace-flow/pricing` does per-message pricing only and `agent_priced_usage` (1c) is the
sole subagent-dedup runtime (`buildPricedUsageView` demoted to a test-spec); hardened the verification
lines on 1b/1c/2b/2c/2d/3a/4a (committed fixtures with expected aggregates; named failure paths →
503 / 5xx / DLQ / `cost_usd` null; redaction canary corpus; per-`(provider,model)` price cache +
backfill load test; Codex turn-index determinism canary; named first-party non-null pricing assertion;
dashboard LOADING/EMPTY/ERROR/PARTIAL states with no desktop CTA + a smoke assertion not "renders");
documented `DateTime64(3)` as a deliberate new convention (1a); fixed the wrong "mirror
`llm_usage_summary`" reference (1b reads base `FINAL`); added `org_id` to both `generateToken` entry
points (2a); marked the Cursor parser (in 3a), 4c, and Phases 5–6 as fast-follow. **README:** slice-B
scope decisions (Claude+Codex first; deploy-gated provisioning; observability-as-task) + dependency
graph updated with 0d/2f and fast-follow markers. **`otto-extraction-reference.md`:** new "Provenance
and licensing" section (SPDX + attribution header for vendored Otto code). The accepted **ADR was left
unedited** — its findings (DateTime64, `cost_usd` Nullable, canonical priced-usage, query-time over
base FINAL) are already documented there.
**Verified:** Docs only, no build run. ROADMAP board now carries 0d + 2f with resolvable `depends-on`;
the README dependency graph and Milestones legend match the board; cross-doc references resolve
(ROADMAP ↔ README "Scope decisions"/"Milestones"; ROADMAP 3a/3b/3c/5a ↔ `otto-extraction-reference.md`
"Provenance and licensing"; ROADMAP "v1 slice complete when" ↔ the slice-B task list).
**Next / blockers:** None. **Slice B** is the build target. First wave is open — **0a, 0b, 0c, 0d**
have no dependencies and can be claimed immediately.

---

## 2026-05-25 — guide bootstrap — docs/agent-analytics-guide

**Status:** ✅ done
**Changed:** Created `docs/guides/agent-conversation-analytics/` with `README.md` (goal +
coordination protocol + dependency graph), `ROADMAP.md` (Phase 0–6 as 24 claimable tasks), and this
`CHANGELOG.md`. No feature code.
**Verified:** Markdown renders; every ROADMAP `depends-on` ID resolves; links to the ADR and
`CONTEXT.md` resolve.
**Next / blockers:** None. First wave is open — tasks **0a**, **0b**, **0c** have no dependencies and
can be claimed immediately.
