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

## 2026-05-26 — 2a (Convex control plane) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Added the Convex control plane for collector ingestion. `schema.ts`: three new tables —
`collectorCredentials` (hidden hashed-secret creds, never user-facing API keys; indexes
`by_org_id`/`by_user_id`/`by_hashed_secret`), `agentSessionOwners` (OCC first-writer `OrgId+session_pk`
claim, `by_org_session`), `collectorCompatibilityPolicy` (Convex-owned min-versions + denylist,
`by_updated_at`). New files beyond the named lane (one component per file): `collectorCredentials.ts`
(generate `tfc_`-prefixed secret + SHA-256 hash, `mint`/`revoke`/`list` returning the secret hash never
to the client, KV sync on write), `agentSessionOwners.ts` (`claimSession` + pure `decideClaim`),
`collectorCompatibilityPolicy.ts` (active = latest by `updatedAt`, fail-closed). `integrations/cloudflare.ts`:
collector creds sync to a **separate** KV namespace (`CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID`, fails
loudly if unset), `syncAll` syncs only `active` creds, both collector sync actions use the same
retry/backoff as the existing sync\* actions. `integrations/tinybird.ts`: single `withRowSecurityParams`
helper stamps `api_keys`+`retention_days`+`org_id` (sentinels when absent) so **both** `generateToken`
and `generateTokenInternal` emit `org_id` — neither path can issue an agent JWT unscoped on org. `http.ts`:
shared-secret-guarded `/agent-ingest/claim-sessions` (validates org + user-in-org, capped batch, sequential
OCC claims) and `/agent-ingest/compatibility-policy` (404 `policy_unavailable` on empty = fail-closed).
`rateLimits.ts`: `mintCollectorCredential` (10/hr). New `__tests__/collectorControlPlane.test.ts`.
**Verified:** `bunx convex codegen` (run from repo root where `convex.json` lives — the functions dir is
`packages/convex` with static codegen) regenerated `_generated` and ran `tsc` clean.
`bunx turbo run lint type-check test --filter=@trace-flow/convex --force` → lint 0 errors, type-check
clean, **474 tests pass**. Collector creds absent from `apiKeys.list` (separate tables, verified by
inspection). Both token paths route through `withRowSecurityParams` (unit-tested for `org_id` emission +
sentinels). First-writer logic unit-tested (`decideClaim`); "no torn state" is the Convex OCC platform
guarantee. CodeRabbit `--agent --type uncommitted`: 9 → 3 → 2 findings across three passes, all addressed
(dropped duplicate `createdAt` for `_creationTime`; retry/backoff on collector KV sync; validate `userId`

- org membership; `.omit('hashedSecret')` public validator; `Infer`-derived `ActivePolicy`; bounded claim
  batch). Skipped with reason: KV-sync `orgId`/`userId` as `v.string()` (matches sibling sync\* actions);
  export status validator (YAGNI); `decideClaim` param `string` (keeps it a pure testable helper). The 4th
  confirmation pass was blocked by a CodeRabbit credit/rate limit; the GitHub bot review on the phase PR is
  the backstop.
  **Next / blockers:** Live `mint`/`list` runtime checks are Convex-auth-gated and not headlessly drivable
  (no `convex-test` harness here); covered by unit tests + structural inspection. Mint schedules a KV sync
  needing `CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID` (provisioned in 0d) and `AGENT_INGEST_SHARED_SECRET` for
  the claim route — wire these in 2e. Next: 2b (`apps/agent-ingest`).

## 2026-05-26 — 1d (Deploy `agent_*` schema to Tinybird) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Deployed the full agent data layer (9 `datasources/agent_*` + the 1b launch pipes, the 1c
canonical view, and the four COPY pipes) to the **cloud dev** workspace `trace_flow_dev`. Tinybird is
not in CI, so this is the manual/scripted path 2c (consumer) and 2e (end-to-end) depend on. Added
`scripts/deploy-agent-tinybird.sh`: it refuses to run unless the current cloud workspace is
`trace_flow_dev` (prod stays gated until 2e), validates offline (`tb build`) and via
`tb --cloud deploy --check`, then `tb --cloud deploy`. No new pipe/datasource files (this task only
deploys 1a/1b/1c). Prod was not touched.
**Verified:** pre-deploy, `tb --cloud sql "SELECT count() FROM agent_messages"` → `Forbidden: Resource
'agent_messages' not found`. `tb build` clean; `tb --cloud deploy --check` → all `agent_*` resources
`status: new`, no destructive ops, "Deployment is valid". Ran the wrapper → deployment #67 promoted and
live. Post-deploy, `agent_messages`, `agent_priced_usage`, and `agent_sessions` all resolve (count 0,
empty as expected — no rows inserted into shared dev); `tb --cloud datasource ls` shows all 9
`agent_*` datasources. CodeRabbit clean (pass 2; pass 1 added the offline `tb build` step to the
wrapper).
**Next / blockers:** **Phase 1 complete** (1a–1d all ✅) → phase-boundary self-merge PR to `main`.
Merging is inert for prod: Tinybird isn't in CI and `deploy.yml` has no jobs touching the agent layer
yet (added in 2e). Next claimable work is Phase 2 — 2a (Convex control plane, dep 0a ✅) is the entry
point.

## 2026-05-26 — 1c (COPY rollup pipes) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Added the canonical priced-usage view + four COPY rollups so session cost, the usage
rollups, and PR authoring cost agree by construction. `pipes/agent_priced_usage.pipe` is a generic
pipe (no `TYPE` — Forward's include-file replacement, referenced by name) that lives the subagent
dedup rule once: every direct Agent Message (top-level, nested, sidechain) counts; source-reported
subagent usage (`agent_tool_events.extracted_subagent_*`) counts only when no matching
nested/sidechain message exists for `(source, session_pk, agent_id)`, and the fallback row carries
tokens with `cost_usd` NULL + `subagent_cost_coverage = 'fallback'` (lowers priced coverage instead of
mis-counting). `pipes/agent_sessions_copy.pipe` (5 nodes) rebuilds one row per session over the view,
joining tool/file/PR base tables; `COPY_MODE replace` + unpartitioned target means a session spanning
multiple `EventAt` days collapses to one row; PR url is set only when exactly one distinct link
exists. `pipes/agent_usage_1h_copy.pipe` / `_1d_copy.pipe` roll up `usage_kind = 'direct'` rows
(MessageCount stays a true message count); `pipes/agent_tool_usage_1h_copy.pipe` reads base
`agent_tool_events FINAL` (tool mix is not a cost surface) and keeps success/failure/unknown separate.
Schedules staggered (1h `0 * * * *`, 1d `15 * * * *`, tool `30 * * * *`, sessions `45 * * * *`),
matching the `llm_usage_*_copy` hourly-refresh-of-daily-bucket convention. Added
`scripts/gen_1c_fixtures.py` and additive `org_1c` fixture rows (the 1b `org_test` endpoint tests are
untouched — every launch pipe filters by org).
**Verified:** `tb build` clean; `tb --local deploy` materialized schema; appended fixtures with zero
quarantine rows; `tb copy run` populated all four targets and a second run left counts identical
(idempotent `replace`). Asserted via `tb --local sql`: `agent_priced_usage` org*1c = 10 rows, exactly
1 `subagent_fallback` (sub1 both-forms counts the overlap once with no fallback row; sub2 fallback-only
adds one row, output 70, NULL cost, coverage `fallback`); `agent_sessions` cc1 constant-cost = 4 msgs
× 0.25 → cost 1.0 (input 400, tools 2, failure 1, files 2, PR pull/1); span1 = ONE row across
2026-05-20→05-21 (duration 86400000 ms, cost 1.0, ambiguous PR url ''); sub1 cost 0.8, sub2 cost 0.4 /
output 90. `agent_usage_1h` 10:00 bucket = 7 msgs / 3 sessions / 2.2 cost; `agent_usage_1d` 05-20 = 8
msgs / 4 sessions / 2.7; `agent_tool_usage_1h` git 3/3 success, npm 1/1 failure. `tb test run` 3/3
(1b endpoint tests green with org_1c added). CodeRabbit: pass 1 fixed 3 script nits; pass 2's 6
findings all verified false-positive (1d cron matches `llm_usage_1d_copy`; branch label correct;
ruff/ANN401 not configured; `CacheCoverage = 'full' | 'missing'` has no 'partial'; duration
non-negative by min/max; sentinel = over-engineering).
**Next / blockers:** 1c done → Phase 1 has only 1d (Deploy `agent*\*`schema to Tinybird) left. Claim
1d next; completing it closes Phase 1 and triggers the phase-boundary self-merge PR to`main`.

## 2026-05-25 — 1b (Launch-query pipes) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Added the three query-time-first launch pipes, each reading base `… FINAL` (not the 1c
rollups). `pipes/agent_failure_leaderboard.pipe` ranks `(tool_name, command_family)` by `failure_rate`
over a window, with a `min_events` display floor; `failure_rate = failure / (success + failure)` —
`unknown` is counted in `event_count` but excluded from the denominator (ADR §357), and is null when
the denominator is 0. `pipes/agent_tool_period_delta.pipe` compares the requested window against the
immediately-preceding equal-length window, ranking by `abs(count_delta)`. `pipes/agent_session_outliers.pipe`
(three nodes) aggregates per session from `agent_messages FINAL` (cost via `sum(cost_usd)`, which skips
the lone nullable column) LEFT JOIN `agent_file_events FINAL` (event + unique-path counts), ranked by
estimated cost. All three enforce `org_id` (JWT `fixed_params`), accept optional `source` /
`repo_fingerprint` filters, and clamp to `retention_days`. **Bootstrapped the repo's first `tb` test
harness:** `tests/{agent_failure_leaderboard,agent_tool_period_delta,agent_session_outliers}.yaml` plus
full-column fixtures `fixtures/agent_{tool_events,messages,file_events}.ndjson`.
**Verified:** `tb build` clean; `tb test run` 3/3 pipes (4 cases) green against committed NDJSON
fixtures with hand-computed expected aggregates — exact rows/values, not "returns rows": leaderboard
`failure_rate` excludes `unknown` (git 1/4 = 0.25 with the unknown still in `event_count` = 5), the
`min_events` floor hides the single-failure Read at 5 and surfaces it (rate 1.0) at 1; period movers
ranked by `abs(count_delta)`; null per-message cost skipped by `sum`. CodeRabbit `--type uncommitted`:
no findings (clean first pass). Four gotchas resolved: (1) String params + `parseDateTime64BestEffort`
fail `tb build` because the builder substitutes the `__no_value__` sentinel over declared defaults —
switched to `Int64` epoch-ms params + `fromUnixTimestamp64Milli` with a `now()`-relative default; (2)
`start_dt - (end_dt - start_dt)` errors (`subtractSeconds` needs a number) — compute `span_ms` in
integer ms first; (3) strict JSONPath ingestion quarantines any row missing a non-Nullable column, so
fixtures carry every column; (4) `now() - toIntervalDay(36500)` underflows DateTime's 1970 floor and
wraps to 2062 — tests pass `retention_days=20000` to neutralize the tier floor for fixed-date fixtures
(production passes 7..365).
**Next / blockers:** 1c (COPY rollup pipes) is the next claimable task (deps 1a ✅). The pipes are not
yet deployed to the cloud dev workspace — that is 1d, gated until 2e.

## 2026-05-25 — 1a (9 `agent_*` datasources) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Added the 9 `agent_*` Tinybird datasources. Five base fact tables
(`agent_messages`, `agent_tool_events`, `agent_file_events`, `agent_capability_snapshots`,
`agent_pull_request_links`) are `ReplacingMergeTree(IngestedAt)` keyed `OrgId, session_pk, <row>_pk`,
partitioned `toYYYYMMDD(EventAt)`, TTL `toDateTime(EventAt) + 1y`. `agent_sessions` is
`ReplacingMergeTree(IngestedAt)` keyed `OrgId, session_pk` with no partition key, TTL on `LastEventAt`.
Three rollups (`agent_usage_1h`, `agent_usage_1d`, `agent_tool_usage_1h`) are `AggregatingMergeTree`
keyed low-to-high cardinality with `BucketStart` leading (mirroring `llm_usage_1h`). `cost_usd
Nullable(Float64)` is the only nullable column. The 5 base fact tables carry `json:$.<col>` JSONPaths
(keys == column names) because the consumer POSTs to them via `/v0/events`; `agent_sessions` + rollups
omit JSONPaths since they are rebuilt from base `FINAL` by Copy Pipes (1c), like `llm_requests`.
**Verified:** `tb build` clean across the full project (datasources + all existing pipes). Live insert
against a local `tb` instance via `POST /v0/events?name=agent_messages` (2 rows, 0 quarantined):
same `message_pk` twice with newer `IngestedAt` → `SELECT … FINAL` count = 1 keeping the newer row
(output_tokens 999, cost_usd 0.99); a distinct `message_pk` → `FINAL` count = 2; `cost_usd: null`
ingests as `None`. Root-caused a pre-existing `tb build` failure on `otel_traces` to a stale local CLI
(4.2.1 → 4.5.8) — out of lane, fixed by updating the CLI, not the datasource. CodeRabbit: 2 trivial
findings (move `OrgId` before `BucketStart` in the two rollup sorting keys) declined as false positives
— the ADR (§Table physics, line 373) and ROADMAP (1a) explicitly specify low-to-high cardinality with
`BucketStart` leading, matching the `llm_usage_1h` template; the high-cardinality-first rule applies to
the base fact tables, which already lead with `OrgId`.
**Next / blockers:** 1b (launch-query pipes) and 1c (COPY rollup pipes) now unblocked. Schema is not
deployed to the cloud dev workspace yet — that is 1d (gated until 2e per the deploy-gate).

## 2026-05-25 — 0d (CF resource provisioning + deploy-gate) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Provisioned the three Cloudflare **dev** resources the agent-ingest path needs (they are
not code, so they must exist before 2b/2c/2e can bind them): queues `agent-ingest-dev`
(`0ff3e1668a604c30be4b4f80c0dde54c`) and `agent-ingest-dlq-dev`
(`1c94dd85ae294c6abdecf8d0bc82b108`), mirroring the proxy `trace-flow-requests*` pair, plus KV
namespace `COLLECTOR_CREDS` (`f945ee3d71954ffabd364e3db385d3ab`), separate from the `API_KEYS`
store. `AGENT_INGEST_LIMITER` (rate-limit namespace 2006) is config-only — no provisioning call.
Recorded all IDs + the account ID in new
`docs/guides/agent-conversation-analytics/provisioned-resources.md`, which 2e reads for wiring and 2f
extends into the teardown runbook. **Deploy-gate** confirmed by absence: `deploy.yml` / `preview.yml`
use explicit per-worker jobs (no matrix), and neither references the agent workers, so a mid-phase
self-merge to `main` leaves the agent path inert and deploy-safe until 2e adds the jobs.
**Verified:** `wrangler queues list` shows both queues; `wrangler kv namespace list` shows
`COLLECTOR_CREDS`; `grep -nE 'agent-ingest|agent-consumer' .github/workflows/{deploy,preview}.yml` →
no matches (gate holds); `prettier --check` clean on the new doc; `coderabbit review --agent` → 0
findings (one minor lifecycle-wording finding fixed first).
**Next / blockers:** none. Phase 0 (0a–0d) is complete — next is the phase-boundary self-merge of
`t3code/ab83918d` → `main`. Blast radius stayed `*-dev`.

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
