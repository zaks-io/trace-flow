---
name: trace-flow-review-pr
description: Reviews a Trace Flow PR against its Linear issue, acceptance criteria, repo invariants, tests, and docs. Use when reviewing PRs or routing Changes Requested feedback.
---

# Trace Flow Review PR

Review PRs for correctness, security posture, and issue fit. Use a bug-focused
review stance.

## Review Model

Use the strongest available code-review-capable model and reasoning setting. Do
not use the fast implementation workhorse as the default reviewer when a
stronger review tier is available.

If only a lower-tier reviewer is available, state that limitation. Do not move
security-sensitive, schema, destructive-data, auth, background job, stream, or
cross-cutting PRs to `Ready to Merge` without a strong review pass or explicit
human approval.

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
- the PR description, commits, changed files, and checks
- the linked Linear issue body, comments, labels, dependencies, and linked docs

Also use `trace-flow-code-review` or `code-review` and the shared checklist for
the bug taxonomy.

## Review Checks

Check:

- the PR implements the linked issue and does not bundle unrelated work
- acceptance criteria are satisfied and observable
- tests are meaningful for risky behavior and would fail for likely bugs
- contracts, docs, generated artifacts, and operational notes are updated when
  behavior changed
- auth, tenant isolation, API keys, body storage, logging, retention, queue
  behavior, stream handling, and Tinybird/Convex behavior still match ADRs and
  specs
- required checks passed, or skipped checks have an explicit reason

## Output

Lead with findings, ordered by severity, with file and line references when
available. If there are no blocking findings, say that directly and list any
residual risk or test gap.

When running under the orchestrator and findings require author changes:

- post detailed feedback on the PR
- move or ask the orchestrator to move Linear to `Changes Requested`
- send feedback back to the original implementation worker thread
- keep fixes on the same branch and PR

Move Linear to `Ready to Merge` only when the user asked you to manage Linear
state, review is clean, and required checks are passing.
