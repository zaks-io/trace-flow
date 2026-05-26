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
