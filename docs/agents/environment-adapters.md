# Environment Adapters

The shared workflow lives in `docs/agents/workflow.md`. This file only explains
which runtime to choose and what each runtime must read.

> **Runtime vs environment.** This file is about which _agent runtime_ (Codex /
> Claude / Cursor) handles a task. That is different from which _deployment
> environment_ the code runs against. For the latter — **Local Workers**,
> **Cloud-Dev**, **Self-Contained Local**, **Control Plane** / **Data Plane** —
> see the **Environments** section of `CONTEXT.md` and
> `docs/agents/local-environment.md`. Do not say "dev" without naming which.

## Codex

Use Codex for local orchestration, repo-wide edits, verification, PR creation,
Linear maintenance, and review loops that need access to local worktrees.

Codex should read:

- `AGENTS.md`
- `docs/agents/workflow.md`
- `docs/agents/skill-usage.md`
- the specific skill for the task

## Claude

Use Claude for planning, documentation, second-pass review, or implementation
when the user explicitly chooses it. Claude should use the repo-local skills
under `.claude/skills`, which link to `.agents/skills`.

Claude should read the same shared workflow docs as Codex and any issue-linked
specs, ADRs, or runbooks before editing.

## Cursor

Use Cursor Background Agents for isolated remote implementation where the issue
is already `Todo` + `ready-for-agent`, and labeled `remote-cursor`.

Cursor agents should:

- read `.cursor/rules/trace-flow.mdc` and `docs/agents/remote-cursor-agent.md`
- implement one Linear issue per branch and PR
- resume the same thread, branch, and PR when the orchestrator sends
  `Changes Requested` feedback
- run or request `ziw-code-review` before PR handoff
- stop on missing product, security, credential, provider, hosted access, or
  ADR decisions

## Runtime Selection Hints

Use Cursor when the issue is isolated, well specified, implementation-heavy, and
locally or CI verifiable.

Use Codex when the task needs local verification, repo-wide cleanup, Linear
state management, PR watching, or orchestration maintenance.

Use Claude when the task is mostly planning, documentation, or independent
review and the user wants that runtime.
