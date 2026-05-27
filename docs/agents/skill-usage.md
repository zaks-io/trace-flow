# Skill Usage

Use the smallest skill that matches the job. Repo-local skills are canonical in
`.agents/skills`; Claude reads the same skills through symlinks in
`.claude/skills`.

| Task                                                                   | Skill                          |
| ---------------------------------------------------------------------- | ------------------------------ |
| Pick up the next repo item and drive it toward a PR                    | `trace-flow-next-pr`           |
| Coordinate multiple issues, worker runs, PR checks, and feedback loops | `trace-flow-orchestrator`      |
| Implement one ready Linear issue                                       | `trace-flow-implement-issue`   |
| Review local changes before PR                                         | `trace-flow-local-code-review` |
| Review one PR against its issue and repo invariants                    | `trace-flow-review-pr`         |
| Trace Flow local diff or PR bug review                                 | `trace-flow-code-review`       |
| Create a PR from an existing branch                                    | `trace-flow-create-pr`         |
| Generic local diff or PR bug review                                    | `code-review`                  |
| Generic PR creation compatibility path                                 | `create-pr`                    |
| Production or dev observability investigation                          | `trace-flow-observability`     |

## Runtime Locations

- Codex reads repo-local skills from `.agents/skills`.
- Claude reads repo-local skills from `.claude/skills`, which should be
  symlinks to `.agents/skills`.
- Cursor Background Agents should read this file, `.cursor/rules/trace-flow.mdc`,
  and `docs/agents/remote-cursor-agent.md`.

Do not create runtime-specific copies of the workflow logic. Update
`docs/agents/workflow.md` and the canonical `.agents/skills` files first; keep
`.claude/skills` as links.

## Maintenance Guard

Run `bun run agent-skills:check` after editing repo-local workflow skills. It
verifies that `trace-flow-*` skill names match their directory names, OpenAI UI
prompts reference the matching skill, and `.claude/skills` entries resolve to
`.agents/skills`.

## Status Vocabulary

Use the status meanings from `docs/agents/workflow.md`:

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

When a runtime or Linear workspace lacks one of these states, use the closest
configured state only after saying which mapping is being used.
