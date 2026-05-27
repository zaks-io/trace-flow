---
name: agent-analytics-driver
description: Autonomously advances the Agent Conversation Analytics build defined in docs/guides/agent-conversation-analytics/ROADMAP.md. One invocation does exactly one safe unit of work (claim -> implement -> verify -> local code-review -> commit), and opens a PR to main (never self-merges) at phase boundaries. Use when the user wants to "keep working the agent-analytics plan", "drive the roadmap", "build the next agent-analytics task", or run this under /goal or /loop. Scoped to Phases 0-4; hands off Phases 5-6 (Tauri GUI + signed release).
---

# Agent Analytics Driver

The execution engine for the Agent Conversation Analytics feature. It is **stateless across
invocations**: every run re-reads the ROADMAP to decide the next safe action, so it behaves
identically whether driven by `/goal`, `/loop`, or manual re-invocation.

**Design source of truth:** `docs/adr/agent-conversation-analytics.md` (column lists, engines, identity
rules). Coordination protocol + task lanes: `docs/guides/agent-conversation-analytics/README.md`.
Vocabulary: `CONTEXT.md`. This skill never restates the design — the ADR wins.

## One invocation = one safe unit of work

1. **Orient.** Read `ROADMAP.md` + `CHANGELOG.md`. Identify every `✅ done`, anything `🚧`/`⛔`, and
   the next `☐ todo` whose dependencies are all `✅`. Confirm the current branch is `agent-analytics`
   (create it off `main` if missing; never work on `main` directly).
2. **Stop-check (before doing anything).** If a stop condition below holds, print the board + reason
   and stop. Do not start work you cannot finish or verify.
3. **Claim.** Set the task's ROADMAP status to `🚧 agent-analytics`.
4. **Implement** strictly inside the task's listed files/dirs. Needing another task's files means the
   split is wrong — note it in the CHANGELOG and stop, don't reach across lanes.
5. **Verify** (all output must land in the transcript — see matrix below). Run the task's own verify
   line first, then the repo gates.
6. **Review.** Run the local `code-review` skill (prefer the read-only `code-reviewer` subagent) over
   the uncommitted diff in `<task-dir>`. Fix every P0/P1 and obvious mechanical P2 finding and
   re-review until the verdict is **READY TO LAND**. Escalate to CodeRabbit
   (`coderabbit review --agent --type uncommitted --dir <task-dir>`) only when the skill's rubric calls
   for it (schema migration, redaction, concurrency, contract change, or unresolved uncertainty), and
   treat a CodeRabbit rate-limit as a skip, not a blocker. If the review can't reach READY TO LAND,
   stop and report the findings.
7. **Land.** Commit onto `agent-analytics` (Conventional Commits, one commit per task). Set ROADMAP
   status `✅ done` and **prepend** a `CHANGELOG.md` entry (newest-first; absolute dates only).
8. **Phase boundary?** If this task completes a phase (all of its tasks `✅`), run the merge step.
9. **Echo the board.** Always end by printing the ROADMAP board table + the single next action. The
   `/goal` evaluator only sees the transcript, so this print is what proves progress.

## Verification matrix (surface every command + result)

| Task kind                          | Verify with                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Types / contract (0a)              | `bun run type-check`; Rust round-trip fixture (`cargo test -p collector-contracts`)                                        |
| Rust crates (0b, 3a–3d)            | `cargo test`, `cargo clippy`, `cargo fmt --check` on the workspace                                                         |
| Pricing pkg (0c)                   | `bun run --filter @trace-flow/pricing test`                                                                                |
| CF provisioning (0d)               | `wrangler queues list` / `kv namespace list` show the resources; the CI deploy workflow excludes both new workers until 2e |
| Tinybird datasources/pipes (1a–1c) | `tb build`; live insert + `SELECT … FINAL` against the **dev** workspace                                                   |
| Convex (2a, 2d)                    | `bunx convex dev --once`; `bunx convex run …` (NEVER `convex deploy`)                                                      |
| Workers (2b, 2c, 2e)               | per-pkg vitest (`@cloudflare/vitest-pool-workers`); `bun run dev:all` curl                                                 |
| Observability (2f)                 | forced consumer error → Sentry; DLQ-non-empty + priced-coverage% alerts fire; runbook names the `tb`/`wrangler` teardown   |
| Dashboards (4a, 4b)                | build + render in the **preview** deploy; verify in a browser (Playwright)                                                 |
| Repo gates (always)                | `bunx turbo run lint type-check test build --filter=<changed pkg>`                                                         |

If a verify step needs infra the agent can't reach (e.g. `tb` not logged into a dev workspace),
**stop and report** — do not mark a task done on `tb build` alone when its verify line requires a
live insert.

## Gates, merge, and deploy

- **Per task (local, synchronous):** repo gates green **and** the local `code-review` skill returns
  **READY TO LAND** before any commit. This is the real review gate; CodeRabbit is on-demand
  escalation only (auto-review is disabled in `.coderabbit.yaml`).
- **Merge unit = a whole phase, not a task.** Work accumulates as commits on `agent-analytics`.
- **At a phase boundary:** push `agent-analytics` and open a PR to `main`, then in a single bounded
  bash poll (≤10 min) wait for CI (`gh pr checks --watch`). CodeRabbit auto-review is OFF; if the
  phase touched a high-risk area on the escalation rubric, request one pass with a `@coderabbitai
review` PR comment and address any blocking finding. **Do not self-merge** — merging to `main` is an
  ungated production deploy, so hand the PR off for a human merge decision and stop.
- **Merge to `main` = production deploy.** `deploy.yml` fires on push to `main`.
- **Wiring gap — handle in Phase 2:** `deploy.yml` has **no** jobs for `apps/agent-ingest` /
  `apps/agent-consumer`, and `preview.yml` only auto-includes them if they expose a `deploy:preview`
  script (its PR-comment URLs are hardcoded to web/api/proxy). Add the deploy + preview jobs as part
  of task 2e **before** merging Phase 2 to `main`, or the new workers never reach prod.

## Stop conditions (print board + reason, then stop)

- **Ceiling reached:** every Phase 0–4 task is `✅` **except `4c`** (Connected Desktops is fast-follow:
  it needs the Phase 5 desktop connect flow that mints device credentials, so it can't be built or
  verified headlessly). Never claim `4c`; don't let it block the ceiling. Hand off Phases 5–6 (Tauri
  GUI first-run + macOS signed release need a GUI + Apple secrets and can't be verified headlessly).
- A task is `⛔ blocked`, or needs a design decision **not** answered by the ADR.
- A verify step needs infra the agent can't reach (Tinybird dev workspace, etc.).
- The local `code-review` skill can't reach READY TO LAND after fixing its findings (a P0/P1 the lane
  can't resolve).
- CI is red on a phase PR for a reason the agent can't fix within the lane.

## Hard safety rules

- **Never** `convex deploy` or touch Convex env vars; `bunx convex dev --once` only (also hook-blocked).
- **Tinybird inserts go to `trace_flow_dev` ONLY.** The same login is admin on `trace_flow_prod` too,
  so this is discipline, not enforced: confirm `tb workspace current` is `trace_flow_dev` before any
  insert, and never `tb workspace use trace_flow_prod`. `tb build` is offline and always safe.
- **Never** force-push; never deploy prod manually (CI/CD on merge is the only path).
- Worker bindings are **required** — fail loudly, no defensive optionals.
- **Log every error before returning an HTTP error** (no silent failures).
- `cost_usd` is the only `Nullable` column; sparse metrics use `0` + coverage columns.
- No stored `agent_file_events` path may contain a home dir or username.
- Never commit secrets; never add `bun.lock`/lockfiles to a feature commit unintentionally.
- Stay in the task's file lane. Don't refactor or "clean up" outside it.

## How to drive this skill

Local `code-review` makes every turn **synchronous**, so `/goal` works cleanly here. The intended
driver is **one repeatable `/goal` that runs this skill on a loop**. Each turn the skill does one safe
unit of work and reprints the board, and the evaluator reads that board from the transcript to decide
whether to fire again. The exact goal text, pre-flight checklist, and stop clauses live in
[`goal.md`](./goal.md) next to this file. Fire that; don't hand-write a new one.

Alternatives, only if you want tighter checkpoints:

- **One `/goal` per phase:** swap the goal's task list for a single phase's IDs, then review the diff
  and prod health before firing the next phase. More milestone control, more babysitting.
- **`/loop 15m`** wrapping the skill: timed pacing for a fully hands-off run that sidesteps
  single-session context compaction across ~19 tasks; review moves to after the fact.
