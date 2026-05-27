---
name: trace-flow-create-pr
description: Creates a Trace Flow pull request with quality checks, local review, Linear linking, and a structured PR body. Use when opening or shipping a PR from the current branch.
argument-hint: 'Optional context to fold into the PR title/body'
---

# Trace Flow Create PR

Stop and report if anything blocks progress. Do not invent fixes. Never bypass
hooks. Never push to `main` or force-push. Never commit secrets. Never deploy
production manually.

## 1. Gather Context

Run in parallel:

- `git status`
- `git diff HEAD`
- `git branch --show-current`
- `git log --oneline -10`

## 2. Linear Lookup

Find the ticket this work belongs to before naming the branch or opening the PR:

1. If the current branch encodes a ticket ID, fetch it via Linear.
2. Otherwise, search Linear using the branch name, commit subjects, and diff as
   keywords. If a likely match turns up, confirm before treating it as the
   ticket. If nothing matches, proceed with no ticket.

Capture the issue's original intent: title, description, scope, out-of-scope,
and acceptance criteria. Use it for branch name, PR title, and summary.

## 3. Pre-Flight

- If already on a feature branch, use it. If on `main` or detached HEAD, create
  a new `codex/<short-kebab-summary>` branch and include `TRA-<number>` when a
  ticket was found.
- Check for an existing PR and exit with its URL if one exists.
- Include all staged and unstaged changes by default, except secrets.
- If the diff contains clearly separate concerns, stop and ask how to split.

## 4. Quality Checks

- Run `bun run ci:check`.
- On failure, auto-fix only mechanical issues and rerun.
- Never use `--no-verify`.

## 5. Local Review And CodeRabbit Decision

Run `trace-flow-local-code-review` for issue work, or `trace-flow-code-review`
for a general diff. Prefer the read-only `code-reviewer` subagent.

Fix all P0/P1 findings and obvious mechanical P2 findings before committing.
Ask before broad, architectural, product, security, or data-behavior changes.
If review fixes changed code, rerun `bun run ci:check`.

Default CodeRabbit to skipped. Trigger it only for high-risk or complex work:
auth, authorization, secrets, destructive data changes, Tinybird/Convex schema,
queue/consumer concurrency, proxy streaming/capture, public contracts, broad
refactors, unresolved local-review uncertainty, or explicit user request.

## 6. Commit

- Stage everything with `git add -A`, then unstage `.env*` or credential files.
- Do not stage `bun.lock` unless dependencies changed intentionally.
- Use Conventional Commits and include `Linear: TRA-123` when a ticket was
  found.
- If hooks fail, fix the root cause and create a new commit. Do not bypass.

## 7. PR Description

Title: Linear ticket title if available, otherwise derived from commits. Keep it
under 70 characters.

Body:

```md
## Summary

[1-3 sentences]

## Changes

- [key change]
- [key change]

## Risk: LOW | MEDIUM | HIGH

- Areas touched: [systems/modules]
- Security: [auth/secrets/data handling, or "none"]
- Performance: [streams/queue/Tinybird/Convex/caching, or "none"]
- Breaking: [yes/no]

## Test plan

- [ ] [verification step]
- [ ] [verification step]

[Linear: TRA-123](url)
```

Risk is HIGH for auth, schema migrations, proxy streaming, queue/consumer
changes, secrets, or production data-flow changes. MEDIUM for business logic,
new features, and non-trivial refactors. LOW for docs, tests, and isolated UI
changes.

## 8. Push, Create, And Link

Push the branch and create a ready-for-review PR unless the user asked for a
draft. After creation:

- attach or link the PR to the Linear issue when one was found
- move the issue to `In Review`
- comment with checks run, local review verdict, CodeRabbit decision, acceptance
  criteria status, and any differences from the original issue intent

Do not move the issue to `Done`; the PR is not merged.

## 9. Report

```text
PR:     <url>
Title:  <title>
Risk:   <LOW|MEDIUM|HIGH>
Review: local review <verdict>; CodeRabbit <skipped|CLI|PR review>
Linear: <ID @ status, or "none" / "skipped">
```
