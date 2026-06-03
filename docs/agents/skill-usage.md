# Skill Usage

Workflow logic lives in the centrally-managed `ziw-*` org skills (pinned by
`skills-lock.json`). Repo-specific values live in `docs/agents/workflow/config.md` — read it
before using any workflow skill. Repo-local skills are canonical in `.agents/skills`; Claude
reads the same skills through symlinks in `.claude/skills`.

| Task                                                             | Skill                      |
| ---------------------------------------------------------------- | -------------------------- |
| Orchestrate tracked work: select, delegate, review, update       | `ziw-orchestrate`          |
| Implement one startable issue through PR creation                | `ziw-implement`            |
| Independent PR review and main-branch drift review               | `ziw-review`               |
| Tracker cleanup: orphans, labels, priorities, agent-ready bodies | `ziw-triage`               |
| Turn a spec/PRD/epic into dependency-ordered tickets             | `ziw-to-issues`            |
| Shared review gate (pre-PR self-check, PR review)                | `ziw-code-review`          |
| Create a PR from the current branch                              | `ziw-pr`                   |
| Create or refresh the repo workflow config                       | `ziw-setup`                |
| Production or dev observability investigation                    | `trace-flow-observability` |

`ziw-code-review` should load `docs/agents/review-invariants.md` for the Trace Flow
invariants (streams, `waitUntil`, queue `ack`, Tinybird/Convex schema, redaction boundary,
required bindings, R2 keys) and the CodeRabbit escalation rubric.

## Runtime Locations

- Codex reads repo-local skills from `.agents/skills`.
- Claude reads repo-local skills from `.claude/skills`, which are symlinks to `.agents/skills`.
- Cursor Background Agents should read this file, `.cursor/rules/trace-flow.mdc`, and
  `docs/agents/remote-cursor-agent.md`.

Do not create runtime-specific copies of workflow logic. The `ziw-*` skills are central;
repo differences belong in `docs/agents/workflow/config.md`, not in forked skills. Keep
`.claude/skills` as links to `.agents/skills`.

## Maintenance

The `ziw-*` skills are centrally managed and version-pinned in `skills-lock.json`
(SHA256 per skill, sourced from `zaks-io/skills`). Do not edit them in place — update the
source and re-sync. After any skill change, confirm `.claude/skills/<name>` still resolves to
`.agents/skills/<name>` (e.g. `ls -la .claude/skills`).

## Status Vocabulary

Use the status meanings from `docs/agents/workflow.md` and the verified IDs in
`docs/agents/workflow/config.md`:

- `Triage`
- `Backlog`
- `Todo`
- `In Progress`
- `Blocked`
- `In Review`
- `Changes Requested`
- `Ready to Merge`
- `Done`
- `Canceled`
- `Duplicate`

When a runtime or Linear workspace lacks one of these states, use the closest configured
state only after saying which mapping is being used.
