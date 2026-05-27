---
name: trace-flow-code-review
description: Performs a bug-focused Trace Flow review for local diffs, PRs, and remote handoffs. Use when asked to review code, check a diff, run a pre-PR review, or decide whether CodeRabbit is warranted.
---

# Trace Flow Code Review

Run an independent, bug-focused review before commit or PR. The goal is to catch
correctness, security, data-loss, and regression risks locally so CodeRabbit is
reserved for genuinely hard or high-risk changes.

## Operating Mode

- Prefer the read-only `code-reviewer` subagent so implementation context does
  not bias the review.
- If invoked as a subagent or with `review-only`, do not edit, commit, push, or
  resolve threads. Return findings only.
- If invoked in the main agent and the user explicitly asks to fix, auto-fix
  only mechanical, low-risk issues. Ask before architectural, product,
  security, or data-behavior changes.
- Focus on high-signal defects. Suppress style nits, preference comments, broad
  refactors, and speculative advice.

## Workflow

1. Establish the base and scope.

   ```sh
   git status --short
   git branch --show-current
   git rev-parse --verify origin/main >/dev/null 2>&1 && echo main || echo master
   ```

2. Recover intent before judging implementation. Read the user request, Linear
   issue, PR body, recent commits, `AGENTS.md`, `CONTEXT.md`, relevant ADRs,
   and `docs/agents/workflow.md`. Compare delivered files against intent and
   flag missing requirements or unrelated drift separately from code findings.

3. Read the diff with shape first, then detail.

   ```sh
   BASE=main
   git rev-parse --verify origin/main >/dev/null 2>&1 || BASE=master
   git diff "origin/$BASE"...HEAD --stat
   git diff "origin/$BASE"...HEAD -- ':(exclude)bun.lock'
   git diff --stat
   git diff -- ':(exclude)bun.lock'
   ```

4. Load `../code-review/references/review-checklist.md`, then run each category
   against the diff, including Trace Flow specifics: stream `tee()`,
   `waitUntil`, queue `ack()`, Tinybird schema rules, Convex auth, redaction
   boundary, required bindings, and R2 body key format.

5. Verify before reporting. Every finding needs file:line evidence, a clear
   failure mode, severity, confidence, and a concrete fix direction.

6. Run or recommend focused verification. Use existing checks first:
   - `bun run ci:check` for the full local gate.
   - `bun run --filter <package-name> test` for focused package tests.
   - `bun run knip` for dead code and exports.

7. Decide whether CodeRabbit is worth spending. Default to no after a clean
   local review. Escalate only for high-risk or genuinely complex changes:
   auth, secrets, destructive data, Tinybird/Convex schema, queue concurrency,
   proxy streaming/capture, public contracts, broad refactors, or unresolved
   local-review uncertainty.

## Report Format

```md
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
