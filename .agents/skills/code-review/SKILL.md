---
name: code-review
description: Bug-focused pre-PR code review for local diffs and PRs. Use when asked to review code, check a diff, run a pre-commit or pre-PR review, or decide whether CodeRabbit is worth running on demand.
---

# Code Review

Run an independent, bug-focused review before commit or PR. This is the default review gate now that
CodeRabbit is no longer automatic on every PR. The goal is to catch correctness, security, data-loss,
and regression risks locally so CodeRabbit is reserved for genuinely hard or high-risk changes.

## Operating Mode

- Prefer running this as the read-only `code-reviewer` subagent so the implementation context does not
  bias the review.
- If invoked as a subagent or with `review-only`, do not edit, commit, push, or resolve threads. Return
  findings only.
- If invoked in the main agent and the user explicitly asks to fix, auto-fix only mechanical, low-risk
  issues. Ask before architectural, product, security, or data-behavior changes.
- Focus on high-signal defects. Suppress style nits, preference comments, broad refactors, and
  speculative advice.

## Workflow

1. Establish the base and scope.

   ```bash
   git status --short
   git branch --show-current
   git rev-parse --verify origin/main >/dev/null 2>&1 && echo main || echo master
   ```

2. Recover intent before judging implementation. Read the user request, the Linear issue (team `TRA`)
   or PR body when available, recent commits, and repo instructions (`AGENTS.md`, `CONTEXT.md`,
   `docs/adr/`). Compare delivered files against intent and flag missing requirements or unrelated
   drift separately from code findings.

3. Read the diff with shape first, then detail.

   ```bash
   BASE=main
   git rev-parse --verify origin/main >/dev/null 2>&1 || BASE=master
   git diff "origin/$BASE"...HEAD --stat
   git diff "origin/$BASE"...HEAD -- ':(exclude)bun.lock'
   git diff --stat
   git diff -- ':(exclude)bun.lock'
   ```

4. Load [references/review-checklist.md](references/review-checklist.md), then run each category
   against the diff — including the **Trace Flow specifics** section (stream `tee()`, `waitUntil()`,
   queue `ack()`, Tinybird schema rules, redaction boundary, required bindings). For large diffs,
   review by ownership area and grep for sibling enum/status/type values instead of relying only on
   changed files.

5. Verify before reporting. Every finding needs file:line evidence, a clear failure mode, severity,
   confidence, and a concrete fix direction. If the evidence cannot be quoted from source, lower
   confidence and keep it out of the main findings unless the impact is severe.

6. Run or recommend focused verification. Use existing project checks first:
   - TS/JS: `bun run check` (or `bun run ci:check` when the web build needs dummy env), or scope it
     with `bunx turbo run lint type-check test --filter=<changed pkg>`.
   - Rust: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
   - Dead code / exports: `bun run knip`.

   Add small targeted tests only when they materially prove or prevent the bug being reported.

7. Decide whether CodeRabbit is worth spending. Default to **no** after a clean local review. Escalate
   only when the change is high risk or genuinely complex: auth/authorization, secrets, destructive
   data changes, Tinybird/ClickHouse schema migrations, Convex schema changes, queue/consumer
   concurrency, the proxy streaming/capture path, public API or shared-type contracts, broad refactors,
   unfamiliar framework behavior, or unresolved local-review uncertainty.

8. If CodeRabbit is used, fix only high-priority actionable findings: P0/P1, security, data-loss,
   correctness regressions, or blockers. Do not chase nits, taste, formatting, optional
   micro-optimizations, or broad rewrites unless the user explicitly asks.

## CodeRabbit Options (on demand only)

Automatic and incremental CodeRabbit reviews are disabled in `.coderabbit.yaml`. When escalation is
warranted, use exactly one path:

- **Local CLI before PR:** `coderabbit review --agent --type uncommitted` (scope with
  `--dir <path>`), or `coderabbit review --plain`. Treat missing auth or a rate-limit beyond a short
  wait as a skip — do not block on it; the local review already passed.
- **PR review after create:** comment `@coderabbitai review` for an incremental pass, or
  `@coderabbitai full review` only for a broad, risky PR that needs a complete pass.

Do not add CodeRabbit opt-in keywords to PR descriptions by default. Do not use CodeRabbit autofix
unless the user explicitly requests it.

## Report Format

```markdown
## REVIEW REPORT

Scope check: CLEAN | DRIFT DETECTED | REQUIREMENTS MISSING
Diff: <N files, +X/-Y>
Checks run: <commands or "not run">
CodeRabbit recommendation: SKIP | CLI | PR REVIEW, because <reason>

Findings:

- [P1] (confidence: 9/10) path/file.ts:42 - <bug and impact>
  Evidence: <short quoted line or source fact>
  Fix: <specific direction>

High-priority remaining: <none or list>
Verdict: READY TO LAND | NEEDS REVISION | DO NOT MERGE
```
