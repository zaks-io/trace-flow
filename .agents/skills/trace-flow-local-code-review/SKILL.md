---
name: trace-flow-local-code-review
description: Reviews local Trace Flow changes before a PR exists. Use when reviewing a branch, working-tree diff, or implementation handoff before opening a PR.
---

# Trace Flow Local Code Review

Review local changes before a PR exists. This is a pre-PR quality gate, not a
substitute for PR review.

## Review Model

Use the strongest available code-review-capable model and reasoning setting. If
only a lower-tier reviewer is available, state that limitation in the output.

## Required Context

Read these first:

- `AGENTS.md`
- `docs/agents/workflow.md`
- `docs/agents/repo-navigation.md`
- `docs/agents/autonomous-loop.md`
- `docs/agents/issue-tracker.md`
- `CONTEXT.md`
- `specs/README.md`
- relevant ADRs in `docs/adr/`
- the Linear issue body when the changes correspond to an issue
- context docs named by the issue

Also use `trace-flow-code-review` or `code-review` and the shared review
checklist for the bug taxonomy.

## Diff Scope

Determine the review scope before reading code:

1. Check the current branch and working tree.
2. Identify the base branch, usually `main`.
3. Review committed branch changes against the merge base.
4. Include uncommitted changes when requested or when an implementation worker
   is doing a final self-check before PR.

If the intended issue or base branch is unclear, state the assumption.

## Review Checks

Check:

- the diff is scoped to one Linear issue when issue context is available
- the branch or PR metadata includes the `TRA-<number>` issue
- the implementation satisfies acceptance criteria
- required checks are present or there is a clear reason they have not run
- streams, `waitUntil`, queue `ack`, R2 body keys, Tinybird schemas, Convex
  auth, and redaction boundaries remain correct where touched
- tests cover risky behavior, tenant boundaries, and failure modes for the slice
- docs changed only when the contract changed or the issue required it
- the diff has no leftover TODOs, debug output, commented dead code, unrelated
  cleanup, or broad refactors outside the issue scope

## Output

Lead with findings, ordered by severity, with file and line references when
available.

Use this verdict:

- `READY FOR PR`: no blocking findings remain.
- `NEEDS REVISION`: blocking findings or missing required checks remain.

If findings require implementation changes, keep the Linear issue in
`In Progress`. The assigned implementation worker should fix the same branch
before opening a PR.

## Guardrails

- Do not make code changes unless the user explicitly asks for fixes.
- Do not move Linear to `In Review`; that happens after the PR is opened.
- Do not broaden scope or create product/security decisions during review.
- Create follow-up Linear issues for adjacent work instead of requesting
  unrelated changes in this branch.
- Never include sensitive values in review output, examples, comments, logs, or
  screenshots.
