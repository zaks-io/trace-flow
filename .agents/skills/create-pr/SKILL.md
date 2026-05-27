---
name: create-pr
description: Create a pull request with quality checks, Conventional Commits, and a structured PR body (Summary, Changes, Risk, Test plan). Use when the user asks to open a PR, create a pull request, or ship the current branch.
argument-hint: 'Optional context to fold into the PR title/body'
---

# Create a pull request

Stop and report if anything blocks progress. Do not invent fixes. Never bypass pre-commit/pre-push
hooks. Never push to `main` or force-push. Never commit secrets. Never deploy production manually —
merging to `main` is itself the production deploy (`deploy.yml`).

## 1. Gather context

Run in parallel:

- `git status`
- `git diff HEAD`
- `git branch --show-current`
- `git log --oneline -10`

## 2. Linear lookup

Find the ticket this work belongs to (team `TRA`) **before** naming the branch or opening the PR:

1. If the current branch already encodes a ticket ID (e.g. `feat/TRA-123-foo` → `TRA-123`), fetch it
   via the Linear MCP (`get_issue`).
2. Otherwise, search Linear (`list_issues` / search) using the branch name, commit subjects, and diff
   as keywords. If a likely match turns up, confirm with the user before treating it as the ticket. If
   nothing matches, proceed with no ticket.

When a ticket is found, capture its **original intent** — title, description, scope/out-of-scope, and
acceptance criteria — and use it to inform the branch name, PR title, and summary. Hold onto this;
step 10 compares it against what actually shipped.

If Linear is unavailable, skip — do not block. Note that it was skipped in the final report.

## 3. Pre-flight

- **Pick the branch automatically.** If already on a feature branch, use it. If on `main` or detached
  HEAD, create a new branch without asking — never push to `main`. Name it
  `<type>/<short-kebab-summary>`, and if a Linear ticket was found in step 2, include its ID, e.g.
  `feat/TRA-123-consumer-dlq-alert`.
- Check for an existing PR: `gh pr list --head <branch> --json number,url`. If one exists, print the
  URL and exit.
- **Include everything by default.** Assume all changes — staged and unstaged — go into the PR. Do not
  ask whether to include unstaged changes.
- **Scope check.** Scan the diff for clearly separate concerns — independent packages/apps, or a
  feature mixed with an unrelated refactor. If the changes plausibly belong in more than one PR, stop
  and ask the user whether they want one combined PR or a split (and how to group it). If it reads as
  one coherent change, proceed with a single PR.

## 4. Quality checks

- Run `bun run ci:check` (prettier check + `turbo run lint type-check test build` with dummy web env).
  For a Rust-only change, also run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
  and `cargo test`.
- On failure, auto-fix and re-run.
- **Never** use `--no-verify`.

## 5. Local code review and CodeRabbit decision

Run local review before committing. This is the default review gate now that CodeRabbit is on-demand
only (automatic + incremental reviews are disabled in `.coderabbit.yaml`).

- Run the `code-review` skill against the staged and unstaged diff. Prefer the read-only
  `code-reviewer` subagent so the reviewer has independent context.
- Fix all P0/P1 findings and obvious mechanical P2 findings before committing. Ask the user before
  broad, architectural, product, security, or data-behavior changes.
- If review fixes changed code, re-run `bun run ci:check`.
- Record the local-review verdict for the PR report and Linear comment.

Decide whether CodeRabbit is worth spending. Default to **skip**. Trigger it only for genuinely
complex or high-risk work (the `code-review` skill's escalation rubric is the source of truth):
auth/authorization, secrets, destructive data changes, Tinybird/Convex schema migrations, queue or
consumer concurrency, the proxy streaming/capture path, public API or shared-type contracts, or broad
refactors — or when local review found non-trivial P0/P1 issues, the reviewer still has concrete
uncertainty, or the user explicitly asks.

If CodeRabbit is warranted, choose exactly one path:

- **Local CLI before commit:** `coderabbit review --agent --type uncommitted` (scope with `--dir`).
  Treat missing auth/CLI or a rate-limit beyond a short wait as skipped — the local review already
  passed; do not block on it.
- **PR review after create:** mark `CodeRabbit: PR review planned` for step 9. Do not add opt-in
  keywords to the PR body; request the review explicitly by PR comment.

Do not spend CodeRabbit on docs-only, tests-only, copy/UI-only, formatting-only, simple dependency
metadata, or small isolated bug fixes with good tests. Do not use CodeRabbit autofix unless the user
explicitly asks.

## 6. Commit

- Stage everything (`git add -A`), then unstage any `.env*` or credential files — never commit
  secrets. Do not stage `bun.lock` into a feature commit unless the change actually updates deps. If
  the user chose to split into multiple PRs in step 3, stage only the files for this PR instead.
- Conventional Commits, with a trailer:

  ```text
  <type>: <short description>

  [body, if needed]

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  ```

  Add `Linear: TRA-123` to the body when a ticket was found.

- If pre-commit or pre-push hooks fail, fix the root cause and create a **new** commit (never amend,
  never `--no-verify`).

## 7. PR description

**Title**: Linear ticket title if available, otherwise derived from commits. Under 70 chars.

**Body**:

```markdown
## Summary

[1-3 sentences — the why, not the what]

## Changes

- [key change]
- [key change]

## Risk: LOW | MEDIUM | HIGH

- Areas touched: [systems/modules]
- Security: [auth/secrets/data handling, or "none"]
- Performance: [streams/queue/DB/caching, or "none"]
- Breaking: [yes/no — list if yes]

## Test plan

- [ ] [verification step]
- [ ] [verification step]

[Linear: TRA-123](url)
```

Risk levels:

- **HIGH**: auth, Tinybird/Convex schema migrations, the proxy streaming path, queue/consumer changes,
  secrets, anything that changes prod data flow.
- **MEDIUM**: business logic, new features, non-trivial refactors.
- **LOW**: UI tweaks, docs, tests only.

## 8. Push and create

```bash
git push -u origin <branch>
gh pr create --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)"
```

Capture the PR number from the returned URL. Open the PR **ready for review** (not draft) unless the
user asks otherwise. CI (`ci.yml`) and preview environments (`preview.yml`) run automatically.

## 9. CodeRabbit PR review (only if selected)

Run this step only when step 5 chose the PR-review path or the user explicitly asks for CodeRabbit
after the PR exists. Otherwise skip it; do not wait for automation (auto-review is off).

- Request review with a PR comment: `@coderabbitai review`. Use `@coderabbitai full review` only for a
  broad, high-risk PR.
- Fetch comments with `gh pr view <number> --comments` and
  `gh api repos/{owner}/{repo}/pulls/<number>/comments`.
- Fix only high-priority actionable findings: P0/P1, security, data loss, correctness regressions,
  production blockers, or items the user specifically requests.
- Commit fixes as new commits, never amend published commits. Re-run `bun run ci:check` after fixes.
- Skip nits, style preferences, optional micro-optimizations, and broad rewrites.

Stop and ask the user before opening a wide-ranging change or if findings are ambiguous.

## 10. Link and update Linear

Only if a ticket was found in step 2. Skip cleanly if Linear is unavailable.

1. **Link the PR to the ticket.** Attach the PR URL to the issue via the Linear MCP
   (`create_attachment`, title = PR title).
2. **Fix the status.** Move the issue to **In Review** (or the repo's review-equivalent status). Never
   move it to `Done` — the PR is not merged.
3. **Comment on the ticket** with `save_comment`. State the outcome and, explicitly, **how the
   implementation diverged from the ticket's original intent** captured in step 2:

   ```md
   PR: <url>

   Results:

   - Checks run: <ci:check, local code-review, CodeRabbit skipped/CLI/PR review — pass/fail>
   - Acceptance criteria: <met / partially met — which>

   Differences from the original plan:

   - <scope, approach, or file changes that deviate from the issue — or "none">
   - <follow-up issues created for deferred work>
   ```

   If the implementation matched the ticket exactly, say so rather than omitting the section.

## 11. Report

```text
PR:     <url>
Title:  <title>
Risk:   <LOW|MEDIUM|HIGH>
Review: local code-review <verdict>; CodeRabbit <skipped|CLI|PR review>
Linear: <ID @ status, or "none" / "skipped">
```

## Rules

- Never bypass pre-commit/pre-push hooks; never `--no-verify`.
- Never commit secrets.
- Never push to `main` or force-push.
- Never deploy production manually — merge to `main` is the deploy.
- Prefer `bunx` over `npx`.
